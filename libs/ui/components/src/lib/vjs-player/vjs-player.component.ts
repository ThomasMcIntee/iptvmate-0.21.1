import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    SimpleChanges,
    ViewChild,
    ViewEncapsulation,
} from '@angular/core';
import videoJs from 'video.js';
import '@yangkghjh/videojs-aspect-ratio-panel';
import 'videojs-quality-selector-hls';

type PlayerSource = { src: string; type?: string };

type ElectronApi = {
    getStreamProxyPort?: () => Promise<number>;
};

type BuildProxyUrlOptions = {
    forceTranscode?: boolean;
};

interface PlaybackError {
    stage: 'initial' | 'type-fallback' | 'proxy-fallback' | 'final';
    code?: number;
    message?: string;
    sourceUrl?: string;
    sourceType?: string;
    timestamp: number;
}

/**
 * This component contains the implementation of video player that is based on video.js library
 */
@Component({
    selector: 'app-vjs-player',
    templateUrl: './vjs-player.component.html',
    styleUrls: ['./vjs-player.component.scss'],
    encapsulation: ViewEncapsulation.None,
    standalone: true,
})
export class VjsPlayerComponent
    implements AfterViewInit, OnChanges, OnDestroy
{
    /** DOM-element reference */
    @ViewChild('target') target!: ElementRef<Element>;
    /** Options of VideoJs player */
    @Input() options!: NonNullable<Parameters<typeof videoJs>[1]>;
    /** VideoJs object */
    player!: ReturnType<typeof videoJs>;
    @Input() volume = 1;
    @Input() startTime = 0;
    @Input() showCaptions = false;
    @Input() subtitleUrl: string | null = null;
    @Output() timeUpdate = new EventEmitter<{
        currentTime: number;
        duration: number;
    }>();
    private pendingSources: PlayerSource[] | null = null;
    private isDestroyed = false;
    private lastAppliedSourcesKey: string | null = null;
    private shouldRequestProxyTranscode = false;
    private playbackErrors: PlaybackError[] = [];
    private currentSourceUrl: string | null = null;
    private noVideoFallbackAttemptedFor: string | null = null;
    /** Per-source guard so audio-silence detection only retries once per stream. */
    private silenceCheckAttemptedFor: string | null = null;
    /** Web Audio plumbing for silence detection. */
    private audioContext: AudioContext | null = null;
    private audioAnalyser: AnalyserNode | null = null;
    private audioMediaSource: MediaElementAudioSourceNode | null = null;
    private silenceCheckTimer: ReturnType<typeof setTimeout> | null = null;
    private silenceSamples: number[] = [];

    /**
     * Detects if a source URL is from a remote IPTV provider (Xtream, Stalker, etc.)
     * These URLs often have redirect/SSL issues and should use proxy first
     */
    private isRemoteIptvSource(sourceUrl: string): boolean {
        // Xtream Codes VOD stream URLs
        if (sourceUrl.includes('/movie/') || sourceUrl.includes('/series/')) {
            return true;
        }
        // Stalker portal stream URLs
        if (sourceUrl.includes('/live/') || sourceUrl.includes('/stb/')) {
            return true;
        }
        // Any HTTPS IPTV provider URL (potential SSL issues)
        if (
            sourceUrl.startsWith('https://') &&
            (sourceUrl.includes('cdn') || sourceUrl.includes('vod') ||
             sourceUrl.includes('stream') || sourceUrl.includes('live'))
        ) {
            return true;
        }
        return false;
    }

    /**
     * Categorizes and logs player errors with detailed context
     */
    private logPlaybackError(
        stage: PlaybackError['stage'],
        sourceUrl: string,
        sourceType?: string,
        errorCode?: number,
        errorMessage?: string
    ): void {
        const error: PlaybackError = {
            stage,
            code: errorCode,
            message: errorMessage,
            sourceUrl: this.maskUrl(sourceUrl),
            sourceType,
            timestamp: Date.now(),
        };

        this.playbackErrors.push(error);

        const baseInfo = `[VjsPlayer] ${stage.toUpperCase()} - ${this.maskUrl(sourceUrl)}`;
        const codeStr = errorCode ? ` (Code: ${errorCode})` : '';
        const typeStr = sourceType ? ` | Type: ${sourceType}` : '';

        if (errorCode === 4 || errorMessage?.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
            console.error(
                `${baseInfo}${codeStr} - Format not supported or source unreachable${typeStr}. ` +
                    'This could indicate: (1) SSL/TLS certificate issue, (2) Network unreachable, (3) Format incompatibility.'
            );
        } else if (errorMessage?.includes('ERR_SSL')) {
            console.error(
                `${baseInfo}${codeStr} - SSL/TLS Error${typeStr}. The stream server may not support modern TLS versions. ` +
                    'Consider: (1) Using proxy fallback, (2) Checking server SSL configuration, (3) Manual codec detection.'
            );
        } else if (errorCode === 0) {
            console.error(
                `${baseInfo}${codeStr} - Aborted by user or network${typeStr}`
            );
        } else {
            console.error(
                `${baseInfo}${codeStr} - ${errorMessage || 'Unknown error'}${typeStr}`
            );
        }
    }

    /**
     * Masks sensitive URL info for logging (shows domain only)
     */
    private maskUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            return `${urlObj.protocol}//${urlObj.host}/...`;
        } catch {
            return url.substring(0, 50) + (url.length > 50 ? '...' : '');
        }
    }

    /**
     * Logs summary of all playback errors encountered
     */
    private logErrorSummary(): void {
        if (this.playbackErrors.length === 0) return;

        console.group('[VjsPlayer] Playback Error Summary');
        console.log(`Total errors encountered: ${this.playbackErrors.length}`);

        const stages = ['initial', 'type-fallback', 'proxy-fallback', 'final'] as const;
        stages.forEach((stage) => {
            const stageErrors = this.playbackErrors.filter((e) => e.stage === stage);
            if (stageErrors.length > 0) {
                console.log(
                    `  ${stage}: ${stageErrors.length} error(s) - ` +
                        stageErrors.map((e) => `Code ${e.code}`).join(', ')
                );
            }
        });

        if (this.currentSourceUrl) {
            console.log(`Last attempted source: ${this.maskUrl(this.currentSourceUrl)}`);
        }

        console.log(
            'Recommendations: Check SSL config, network connectivity, and codec support. ' +
                'Enable verbose logging in player config for detailed diagnostics.'
        );
        console.groupEnd();
    }

    ngAfterViewInit(): void {
        this.initializePlayer();
    }

    private initializePlayer(): void {
        if (this.player || this.isDestroyed) {
            return;
        }

        const playerElement = this.target?.nativeElement as HTMLElement | undefined;
        if (!playerElement?.isConnected) {
            return;
        }

        // Log codec support to diagnose playback issues
        const testVideo = document.createElement('video');
        const hevc = testVideo.canPlayType('video/mp4; codecs="hvc1"');
        const hevcAlt = testVideo.canPlayType('video/mp4; codecs="hev1"');
        this.shouldRequestProxyTranscode = !hevc && !hevcAlt;
        console.log('[VjsPlayer] Codec support:', {
            h264: testVideo.canPlayType('video/mp4; codecs="avc1.42E01E"'),
            hevc,
            hevcAlt,
            av1: testVideo.canPlayType('video/mp4; codecs="av01.0.08M.08"'),
            requestProxyTranscode: this.shouldRequestProxyTranscode,
        });

        const initialSources = this.normalizeSources(
            this.pendingSources ?? this.options?.sources
        );
        const baseOptions = { ...(this.options ?? {}) };
        delete (baseOptions as { sources?: unknown }).sources;

        this.player = videoJs(
            playerElement,
            {
                ...baseOptions,
                autoplay: true,
            },
            () => {
                try {
                    this.player.volume(this.volume);
                    this.player.muted(false);
                } catch (e) {
                    console.warn('Failed to set initial VideoJS volume:', e);
                }

                this.player.on('loadedmetadata', () => {
                    if (this.startTime > 0) {
                        this.player.currentTime(this.startTime);
                    }
                });

                this.player.on('volumechange', () => {
                    const currentVolume = this.player.volume();
                    if (typeof currentVolume === 'number') {
                        localStorage.setItem('volume', currentVolume.toString());
                    }
                });

                this.player.on('timeupdate', () => {
                    const currentTime = this.player.currentTime() ?? 0;
                    const duration = this.player.duration() ?? 0;
                    this.timeUpdate.emit({
                        currentTime,
                        duration,
                    });
                });

                // Audio silence detection: some streams (e.g. AC-3 / E-AC-3 / DTS)
                // have a video codec Chromium can decode but an audio codec it cannot,
                // resulting in silent playback with no error. Detect this and retry
                // through the proxy with audio-only transcoding.
                this.player.on('playing', () => this.startSilenceCheck());
                this.player.on('pause', () => this.stopSilenceCheck());
                this.player.on('ended', () => this.stopSilenceCheck());

                const trackList = this.player.textTracks();
                trackList.on('addtrack', () => this.applyTextTrackSettings());
                this.applyTextTrackSettings();

                if (initialSources.length > 0) {
                    this.setPlayerSource(initialSources);
                }

                if (this.subtitleUrl) {
                    this.loadSubtitleTrack(this.subtitleUrl);
                }
            }
        );
        this.pendingSources = null;

        try {
            const playerWithQualitySelector = this.player as ReturnType<typeof videoJs> & {
                qualitySelectorHls?: (options: {
                    displayCurrentQuality: boolean;
                }) => void;
            };
            if (typeof playerWithQualitySelector.qualitySelectorHls === 'function') {
                playerWithQualitySelector.qualitySelectorHls({
                    displayCurrentQuality: true,
                });
            }
        } catch (e) {
            console.warn('qualitySelectorHls plugin failed to initialize:', e);
        }
        try {
            const playerWithAspectPanel = this.player as ReturnType<typeof videoJs> & {
                aspectRatioPanel?: () => void;
            };
            if (typeof playerWithAspectPanel.aspectRatioPanel === 'function') {
                playerWithAspectPanel.aspectRatioPanel();
            }
        } catch (e) {
            console.warn('aspectRatioPanel plugin failed to initialize:', e);
        }
    }

    /**
     * Replaces the url source of the player with the changed source url
     * @param changes contains changed channel object
     */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['options']?.currentValue?.sources?.[0]) {
            const nextSources = this.normalizeSources(
                changes['options'].currentValue.sources
            );
            if (!this.player) {
                this.pendingSources = nextSources;
            } else {
                this.setPlayerSource(nextSources);
                if (this.subtitleUrl) {
                    this.loadSubtitleTrack(this.subtitleUrl);
                }
            }
        }
        if (changes['volume']?.currentValue !== undefined && this.player) {
            try {
                this.player.volume(changes['volume'].currentValue);
            } catch (e) {
                console.warn('Failed to set VideoJS volume:', e);
            }
        }
        if (changes['showCaptions'] && this.player) {
            this.applyTextTrackSettings();
        }
        if (changes['subtitleUrl'] && this.player && this.subtitleUrl) {
            this.loadSubtitleTrack(this.subtitleUrl);
        }
    }

    private loadSubtitleTrack(url: string): void {
        if (!this.player) return;
        // Remove any previously side-loaded subtitle tracks
        const existing = this.player.textTracks() as unknown as TextTrackList;
        for (let i = existing.length - 1; i >= 0; i--) {
            const t = existing[i];
            const trackWithSrc = t as TextTrack & { src?: string };
            if (trackWithSrc.src && (t.kind === 'subtitles' || t.kind === 'captions')) {
                this.player.removeRemoteTextTrack(t as unknown as Parameters<typeof this.player.removeRemoteTextTrack>[0]);
            }
        }
        this.player.addRemoteTextTrack(
            {
                kind: 'subtitles',
                src: url,
                srclang: 'en',
                label: 'Subtitles',
                default: this.showCaptions,
            },
            false
        );
    }

    private applyTextTrackSettings(): void {
        if (!this.player) return;
        const tracks = this.player.textTracks() as unknown as TextTrackList;
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (t.kind === 'subtitles' || t.kind === 'captions') {
                (t as unknown as { mode: string }).mode = this.showCaptions ? 'showing' : 'hidden';
            }
        }
    }

    private normalizeSources(
        sources: PlayerSource[] | PlayerSource | undefined
    ): PlayerSource[] {
        if (!sources) {
            return [];
        }

        const list = Array.isArray(sources) ? sources : [sources];
        return list
            .filter((source): source is PlayerSource => !!source?.src)
            .map((source) =>
                source.type
                    ? { src: source.src, type: source.type }
                    : { src: source.src }
            );
    }

    private getSourcesKey(sources: PlayerSource[]): string {
        return JSON.stringify(sources.map((s) => [s.src, s.type ?? '']));
    }

    private setPlayerSource(
        sourcesInput: PlayerSource[] | PlayerSource,
        allowTypeFallback = true,
        allowProxyFallback = true
    ): void {
        if (!this.player) {
            return;
        }

        const normalizedSources = this.normalizeSources(sourcesInput);
        if (normalizedSources.length === 0) {
            return;
        }

        const nextSourcesKey = this.getSourcesKey(normalizedSources);
        if (this.lastAppliedSourcesKey === nextSourcesKey) {
            console.log('Source already applied, skipping duplicate:', nextSourcesKey);
            return;
        }
        this.lastAppliedSourcesKey = nextSourcesKey;
        this.noVideoFallbackAttemptedFor = null;
        // Reset silence-detection state for each new source.
        this.silenceCheckAttemptedFor = null;
        this.stopSilenceCheck();

        console.log(
            'Setting player source:',
            normalizedSources,
            'allowTypeFallback:',
            allowTypeFallback,
            'allowProxyFallback:',
            allowProxyFallback
        );

        this.currentSourceUrl = normalizedSources[0]?.src ?? null;

        // For remote IPTV sources (Xtream, Stalker), try proxy FIRST to avoid SSL/redirect issues
        // Skip type fallback on first attempt since proxy handles encoding/format negotiation
        if (normalizedSources.length === 1) {
            const source = normalizedSources[0];
            const isAlreadyProxied = source.src.includes('/stream?url=');
            if (!isAlreadyProxied && this.isRemoteIptvSource(source.src)) {
                console.log(
                    '[VjsPlayer] Detected remote IPTV source - prioritizing proxy playback',
                    { url: this.maskUrl(source.src) }
                );
                // Build proxy URL immediately and use it as the primary source
                void this.buildProxyUrl(source.src, source.type).then((proxiedUrl) => {
                    if (proxiedUrl) {
                        console.log('[VjsPlayer] Using proxy as primary source for IPTV stream');
                        // Pass the resolved MIME type so the browser doesn't reject the
                        // proxy URL immediately (it has no file extension to sniff from).
                        const isTranscodedProxy = proxiedUrl.includes('transcode=1');
                        const resolvedType = isTranscodedProxy
                            ? 'video/mp2t'
                            : source.type || this.inferMimeType(source.src);
                        // Apply proxy source directly to avoid recursive setPlayerSource()
                        // calls toggling keys between original/proxy URLs.
                        this.setPlayerSourceDirect(
                            [{ src: proxiedUrl, type: resolvedType }],
                            true,  // Allow type fallback for proxy responses
                            true   // Allow one-shot proxy->transcode retry on failure
                        );
                    } else {
                        console.warn(
                            '[VjsPlayer] Proxy not available - falling back to direct source'
                        );
                        // Proxy not available, try direct with full fallback chain
                        this.setPlayerSourceDirect(
                            normalizedSources,
                            allowTypeFallback,
                            allowProxyFallback
                        );
                    }
                });
                return;
            }
        }

        // Standard playback for local/direct sources
        this.setPlayerSourceDirect(normalizedSources, allowTypeFallback, allowProxyFallback);
    }

    /**
     * Internal method for standard source playback with fallback chain
     */
    private setPlayerSourceDirect(
        normalizedSources: PlayerSource[],
        allowTypeFallback = true,
        allowProxyFallback = true
    ): void {
        if (!this.player) {
            return;
        }

        console.log(
            'Setting player source (direct):',
            normalizedSources,
            'allowTypeFallback:',
            allowTypeFallback,
            'allowProxyFallback:',
            allowProxyFallback
        );

        if (
            allowTypeFallback &&
            normalizedSources.length === 1 &&
            normalizedSources[0].type
        ) {
            const typedSource = normalizedSources[0];
            const onSourceError = () => {
                const currentError = this.player?.error();
                if (currentError?.code === 4) {
                    const errorMsg =
                        `Media error ${currentError.code}: ${currentError.message || 'Format not supported'}`;
                    this.logPlaybackError(
                        'initial',
                        typedSource.src,
                        typedSource.type,
                        currentError.code,
                        errorMsg
                    );
                    console.warn(
                        '[VjsPlayer] Type fallback: Retrying without explicit type (Code 4 error)',
                        { src: typedSource.src, type: typedSource.type }
                    );
                    this.setPlayerSource(
                        { src: typedSource.src },
                        false,
                        allowProxyFallback
                    );
                }
            };

            this.player.one('error', onSourceError);
        }

        if (allowProxyFallback && normalizedSources.length === 1) {
            const directSource = normalizedSources[0];
            const isHttpSource = /^https?:\/\//i.test(directSource.src);
            const isAlreadyProxied = directSource.src.includes('/stream?url=');
            const isTranscodedProxy = directSource.src.includes('transcode=1');

            if (isHttpSource && isAlreadyProxied && !isTranscodedProxy) {
                const onProxyPassthroughError = async () => {
                    const currentError = this.player?.error();
                    if (currentError?.code !== 4) {
                        return;
                    }

                    const targetUrl = new URL(directSource.src).searchParams.get('url');
                    if (!targetUrl) {
                        return;
                    }

                    this.noVideoFallbackAttemptedFor = directSource.src;

                    console.warn(
                        '[VjsPlayer] Proxy passthrough failed - retrying with transcode=1',
                        { source: this.maskUrl(targetUrl) }
                    );

                    const transcodedProxyUrl = await this.buildProxyUrl(
                        targetUrl,
                        directSource.type,
                        { forceTranscode: true }
                    );

                    if (transcodedProxyUrl) {
                        this.setPlayerSource(
                                    { src: transcodedProxyUrl },
                            true,
                            false
                        );
                    }
                };

                this.player.one('error', () => {
                    void onProxyPassthroughError();
                });
            }

            console.log(
                '[VjsPlayer] Proxy fallback check:',
                'isHttpSource:',
                isHttpSource,
                'isAlreadyProxied:',
                isAlreadyProxied,
                'isTranscodedProxy:',
                isTranscodedProxy
            );

            if (isHttpSource && !isAlreadyProxied) {
                const onProxyFallbackError = async () => {
                    const currentError = this.player?.error();
                    if (currentError?.code !== 4) {
                        console.warn(
                            '[VjsPlayer] Proxy fallback skipped - error is not format-related:',
                            'Code:',
                            currentError?.code,
                            'Message:',
                            currentError?.message
                        );
                        this.logPlaybackError(
                            'type-fallback',
                            directSource.src,
                            directSource.type,
                            currentError?.code,
                            currentError?.message
                        );
                        return;
                    }

                    // Type fallback has already been attempted (or wasn't needed).
                    // Now try proxy fallback for Code 4 errors.
                    this.logPlaybackError(
                        'type-fallback',
                        directSource.src,
                        directSource.type,
                        currentError.code,
                        currentError.message
                    );

                    const proxiedUrl = await this.buildProxyUrl(
                        directSource.src,
                        directSource.type
                    );
                    if (!proxiedUrl) {
                        console.error(
                            '[VjsPlayer] Failed to build proxy URL - no proxy port available. ' +
                                'This means the application is running outside Electron mode or proxy is not initialized.'
                        );
                        return;
                    }

                    console.log(
                        '[VjsPlayer] Attempting proxy fallback...',
                        {
                            original: this.maskUrl(directSource.src),
                            proxied: this.maskUrl(proxiedUrl),
                            type: directSource.type,
                        }
                    );
                    this.setPlayerSource(
                        { src: proxiedUrl, type: directSource.type },
                        true,
                        false
                    );
                };

                this.player.one('error', () => {
                    void onProxyFallbackError();
                });
            }
        }

        this.player.pause();
        console.log('Calling player.src() with:', normalizedSources);
        this.player.src(normalizedSources as Parameters<typeof this.player.src>[0]);
        this.player.load();

        if (this.subtitleUrl) {
            this.loadSubtitleTrack(this.subtitleUrl);
        }

        const playPromise = this.player.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((err: unknown) => {
                if (
                    err instanceof DOMException &&
                    err.name === 'AbortError'
                ) {
                    return;
                }

                const errorMsg = err instanceof Error ? err.message : String(err);
                const directSource = normalizedSources[0];

                if (
                    errorMsg.includes('not supported') ||
                    errorMsg.includes('no supported source')
                ) {
                    console.error(
                        '[VjsPlayer] FINAL ERROR - No supported format found.',
                        'Source:',
                        this.maskUrl(directSource.src),
                        'Type:',
                        directSource.type
                    );
                    this.logPlaybackError(
                        'final',
                        directSource.src,
                        directSource.type,
                        4,
                        errorMsg
                    );
                    this.logErrorSummary();
                } else {
                    console.error(
                        '[VjsPlayer] Playback failed:',
                        errorMsg,
                        'Source:',
                        this.maskUrl(directSource.src)
                    );
                }
            });
        }
    }

    private async buildProxyUrl(
        sourceUrl: string,
        sourceType?: string,
        options?: BuildProxyUrlOptions
    ): Promise<string | null> {
        const electronApi = (globalThis as { electron?: ElectronApi }).electron;
        if (!electronApi?.getStreamProxyPort) {
            console.debug(
                '[VjsPlayer] Electron API not available - proxy disabled. ' +
                    'Running in PWA mode where external proxy is not supported.'
            );
            return null;
        }

        try {
            const port = await electronApi.getStreamProxyPort();
            if (!port) {
                console.warn(
                    '[VjsPlayer] No proxy port available - stream proxy server may not be initialized'
                );
                return null;
            }

            const params = new URLSearchParams({ url: sourceUrl });
            const forceTranscode = options?.forceTranscode === true;

            if (forceTranscode || this.shouldTranscodeProxySource(sourceUrl, sourceType)) {
                params.set('transcode', '1');
                console.log(
                    forceTranscode
                        ? '[VjsPlayer] Forcing proxy transcode after passthrough failure'
                        : '[VjsPlayer] Proxy will transcode (HEVC codec not supported)'
                );
            }
            
            const proxyUrl = `http://127.0.0.1:${port}/stream?${params.toString()}`;
            console.log(
                '[VjsPlayer] Built proxy URL successfully',
                'Port:',
                port,
                'Transcode:',
                params.has('transcode')
            );
            return proxyUrl;
        } catch (e) {
            console.error(
                '[VjsPlayer] Failed to get proxy port from Electron API:',
                e instanceof Error ? e.message : String(e)
            );
            return null;
        }
    }

    /** Derive a MIME type from a URL's file extension when no explicit type is provided. */
    private inferMimeType(url: string): string | undefined {
        const path = url.split('?')[0].toLowerCase();
        if (/\.mp4$|\.m4v$/.test(path)) return 'video/mp4';
        if (/\.m3u8$/.test(path)) return 'application/x-mpegURL';
        if (/\.ts$/.test(path)) return 'video/mp2t';
        if (/\.mkv$/.test(path)) return 'video/x-matroska';
        if (/\.mov$/.test(path)) return 'video/quicktime';
        if (/\.avi$/.test(path)) return 'video/x-msvideo';
        if (/\.webm$/.test(path)) return 'video/webm';
        return undefined;
    }

    private shouldTranscodeProxySource(
        sourceUrl: string,
        sourceType?: string
    ): boolean {
        // Only transcode if we actually detected missing HEVC support
        if (!this.shouldRequestProxyTranscode) {
            return false;
        }

        const normalizedType = sourceType?.toLowerCase() ?? '';
        const isMp4Container =
            /\.(mp4|m4v)(\?|$)/i.test(sourceUrl) || normalizedType.includes('mp4');

        // Do not transcode MP4/M4V by default. Use passthrough first and only
        // force transcode when passthrough playback actually fails.
        if (isMp4Container) {
            return false;
        }

        // For other formats (MKV, MOV, etc.), allow transcoding as they might contain HEVC
        return /\.(mov|mkv|avi|wmv|mpeg|mpg|ts)(\?|$)/i.test(sourceUrl);
    }



    /**
     * Begin sampling audio levels from the underlying <video> element. After ~4s
     * of strictly silent samples, retry the current source through the proxy
     * with `transcode=audio` (preserves video codec, transcodes audio to AAC).
     * No-ops if Web Audio is unavailable, the source already uses an audio
     * transcode, or we've already retried this source.
     */
    private startSilenceCheck(): void {
        if (this.isDestroyed || !this.player) return;
        const sourceUrl = this.currentSourceUrl;
        if (!sourceUrl) return;
        // Already retried (or actively checking) this source — bail.
        if (this.silenceCheckAttemptedFor === sourceUrl) return;
        // Source is already an audio-transcode or full-transcode proxy URL — no recovery possible.
        if (sourceUrl.includes('transcode=audio') || sourceUrl.includes('transcode=1')) {
            return;
        }
        // Only worth checking for proxied sources (CORS-safe + retry path exists).
        if (!sourceUrl.includes('/stream?url=')) {
            return;
        }

        const videoEl = this.player
            .el()
            ?.querySelector?.('video') as HTMLVideoElement | null;
        if (!videoEl) return;

        // Tear down any previous Web Audio graph before creating a new one.
        this.stopSilenceCheck();
        this.silenceCheckAttemptedFor = sourceUrl;

        try {
            const Ctor =
                (window as unknown as { AudioContext?: typeof AudioContext })
                    .AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
            if (!Ctor) return;

            const ctx = new Ctor();
            const src = ctx.createMediaElementSource(videoEl);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);
            // Keep audio routed to speakers (MediaElementSource hijacks output otherwise).
            analyser.connect(ctx.destination);

            this.audioContext = ctx;
            this.audioMediaSource = src;
            this.audioAnalyser = analyser;
            this.silenceSamples = [];

            const buffer = new Uint8Array(analyser.frequencyBinCount);
            const sample = () => {
                if (!this.audioAnalyser) return;
                this.audioAnalyser.getByteTimeDomainData(buffer);
                let peak = 0;
                for (let i = 0; i < buffer.length; i++) {
                    // 128 is silence (centered). Distance from center indicates amplitude.
                    const delta = Math.abs(buffer[i] - 128);
                    if (delta > peak) peak = delta;
                }
                this.silenceSamples.push(peak);

                // Sample for ~4s at 250ms intervals (16 samples).
                if (this.silenceSamples.length >= 16) {
                    const maxPeak = Math.max(...this.silenceSamples);
                    this.stopSilenceCheck();
                    if (maxPeak === 0) {
                        console.warn(
                            '[VjsPlayer] No audio detected for 4s — retrying with audio-only transcode'
                        );
                        void this.retryWithAudioTranscode(sourceUrl);
                    }
                    return;
                }
                this.silenceCheckTimer = setTimeout(sample, 250);
            };
            // Skip the first ~750ms to allow the decoder to start producing samples.
            this.silenceCheckTimer = setTimeout(sample, 750);
        } catch (e) {
            console.debug(
                '[VjsPlayer] Web Audio silence check unavailable:',
                e instanceof Error ? e.message : String(e)
            );
            this.stopSilenceCheck();
        }
    }

    private stopSilenceCheck(): void {
        if (this.silenceCheckTimer) {
            clearTimeout(this.silenceCheckTimer);
            this.silenceCheckTimer = null;
        }
        this.silenceSamples = [];
        // NOTE: We intentionally do NOT disconnect/close the AudioContext or
        // MediaElementAudioSourceNode here. Once a <video> has been bound to a
        // MediaElementSource, the only way to keep audio playing is to leave
        // the graph connected. We only release it on destroy.
    }

    private teardownAudioGraph(): void {
        this.stopSilenceCheck();
        try {
            this.audioMediaSource?.disconnect();
        } catch {
            // ignore
        }
        try {
            this.audioAnalyser?.disconnect();
        } catch {
            // ignore
        }
        if (this.audioContext) {
            void this.audioContext.close().catch(() => undefined);
        }
        this.audioMediaSource = null;
        this.audioAnalyser = null;
        this.audioContext = null;
    }

    private async retryWithAudioTranscode(sourceUrl: string): Promise<void> {
        try {
            const u = new URL(sourceUrl);
            const target = u.searchParams.get('url');
            if (!target) return;
            const transcodedUrl = await this.buildProxyUrl(target, undefined, {
                forceTranscode: true,
            });
            // Replace with audio-only flavor by swapping the transcode param.
            if (!transcodedUrl) return;
            const finalUrl = transcodedUrl.replace('transcode=1', 'transcode=audio');
            this.setPlayerSource(
                { src: finalUrl, type: 'video/mp2t' },
                true,
                false
            );
        } catch (e) {
            console.warn(
                '[VjsPlayer] Failed to retry with audio transcode:',
                e instanceof Error ? e.message : String(e)
            );
        }
    }

    /**
     * Removes the players HTML reference on destroy
     */
    ngOnDestroy(): void {
        // Log error summary if any playback errors occurred
        if (this.playbackErrors.length > 0) {
            this.logErrorSummary();
        }

        this.isDestroyed = true;
        this.teardownAudioGraph();
        if (this.player) {
            this.player.dispose();
        }
    }
}
