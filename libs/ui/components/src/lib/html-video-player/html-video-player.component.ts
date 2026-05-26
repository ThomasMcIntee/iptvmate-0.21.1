import {
    Component,
    ElementRef,
    EventEmitter,
    inject,
    Input,
    OnChanges,
    OnDestroy,
    OnInit,
    Output,
    SimpleChanges,
    ViewChild,
} from '@angular/core';
import Hls from 'hls.js';
import { getExtensionFromUrl } from 'm3u-utils';
import { DataService } from 'services';
import { Channel } from 'shared-interfaces';

/**
 * This component contains the implementation of HTML5 based video player
 */
@Component({
    selector: 'app-html-video-player',
    templateUrl: './html-video-player.component.html',
    styleUrls: ['./html-video-player.component.scss'],
    standalone: true,
})
export class HtmlVideoPlayerComponent implements OnInit, OnChanges, OnDestroy {
    /** Channel to play  */
    @Input() channel!: Channel;
    @Input() volume = 1;
    @Input() startTime = 0;
    @Output() timeUpdate = new EventEmitter<{
        currentTime: number;
        duration: number;
    }>();

    private readonly dataService = inject(DataService);
    private readonly electronApi = (globalThis as {
        electron?: {
            setUserAgent?: (userAgent: string, referrer?: string) => void;
            toggleFullScreen?: () => Promise<boolean>;
            isFullScreen?: () => Promise<boolean>;
            getStreamProxyPort?: () => Promise<number>;
        };
    }).electron;

    /** Video player DOM element */
    @ViewChild('videoPlayer', { static: true })
    videoPlayer!: ElementRef<HTMLVideoElement>;

    /** HLS object */
    hls: Hls | null = null;

    /** User-facing playback error message shown as an overlay. */
    errorMessage: string | null = null;
    /** Optional secondary hint shown under the main error message. */
    errorHint: string | null = null;
    /** Whether we've already attempted HLS media-error recovery for the current source. */
    private hlsRecoveryAttempted = false;
    /** Original (pre-transcode) URL for the current channel, used to build transcode retries. */
    private currentSourceUrl: string | null = null;
    /** Tracks which transcode retry stage we're at for the current channel. */
    private transcodeAttempt: 'none' | 'audio' | 'full' = 'none';
    /** Per-source guard so silence detection only retries once per stream. */
    private silenceCheckAttemptedFor: string | null = null;
    private audioContext: AudioContext | null = null;
    private audioAnalyser: AnalyserNode | null = null;
    private audioMediaSource: MediaElementAudioSourceNode | null = null;
    private silenceCheckTimer: ReturnType<typeof setTimeout> | null = null;
    private silenceSamples: number[] = [];
    /** Whether the underlying <video> is currently muted. */
    isMuted = false;
    /** Whether the player-host wrapper is currently in fullscreen. */
    isFullscreen = false;
    /** Whether the user has been recently active (drives controls visibility). */
    isActive = true;
    private activityTimer: ReturnType<typeof setTimeout> | null = null;

    /** Toggle fullscreen on the .player-host wrapper (so overlays remain visible). */
    toggleFullscreen(): void {
        // Prefer HTML element fullscreen so the player host fills the screen even
        // when rendered inside a constrained ancestor (e.g. MatDialog at 80%
        // width). Toggling only the Electron BrowserWindow leaves the dialog at
        // its constrained size, so the movie does not actually fill the screen.
        const host = this.videoPlayer?.nativeElement?.parentElement as
            | (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
            | null;
        const doc = document as Document & {
            webkitFullscreenElement?: Element;
            webkitExitFullscreen?: () => Promise<void>;
        };
        const inFs = !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);

        const fallbackToWindow = () => {
            if (!this.electronApi?.toggleFullScreen) return;
            this.electronApi
                .toggleFullScreen()
                .then((next) => {
                    this.isFullscreen = next;
                })
                .catch(() => undefined);
        };

        if (inFs) {
            const exit =
                doc.exitFullscreen?.bind(doc) ??
                doc.webkitExitFullscreen?.bind(doc);
            const result = exit?.();
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch(() => fallbackToWindow());
            } else if (!exit) {
                fallbackToWindow();
            }
            return;
        }

        if (!host) {
            fallbackToWindow();
            return;
        }

        const req =
            host.requestFullscreen?.bind(host) ??
            host.webkitRequestFullscreen?.bind(host);
        if (!req) {
            fallbackToWindow();
            return;
        }
        const result = req();
        if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => fallbackToWindow());
        }
    }

    /** Mark user as active and (re)start the auto-hide timer. */
    notifyActivity(): void {
        // Always (re)start the timer, but only flip state when actually changing.
        if (this.activityTimer) {
            clearTimeout(this.activityTimer);
        }
        if (!this.isActive) {
            this.isActive = true;
        }
        this.activityTimer = setTimeout(() => {
            this.isActive = false;
        }, 2500);
    }

    /** Force the inactive state (used on mouseleave). */
    setInactive(): void {
        if (this.activityTimer) {
            clearTimeout(this.activityTimer);
            this.activityTimer = null;
        }
        this.isActive = false;
    }

    /** Unmute the player from the overlay button. */
    unmute(): void {
        const video = this.videoPlayer?.nativeElement;
        if (!video) return;
        video.muted = false;
        if (video.volume === 0) {
            video.volume = 1;
        }
        this.isMuted = false;
    }

    /** Captions/subtitles indicator */
    @Input() showCaptions!: boolean;
    /** External subtitle VTT URL to side-load */
    @Input() subtitleUrl: string | null = null;

    ngOnInit() {
        this.videoPlayer.nativeElement.textTracks.addEventListener('addtrack', () => {
            if (this.showCaptions) {
                this.enableCaptions();
            }
        });

        this.videoPlayer.nativeElement.addEventListener('volumechange', () => {
            this.isMuted = this.videoPlayer.nativeElement.muted;
            this.onVolumeChange();
        });

        // Initial sync (autoplay starts muted)
        this.isMuted = this.videoPlayer.nativeElement.muted;

        this.videoPlayer.nativeElement.addEventListener('loadedmetadata', () => {
            if (this.startTime > 0) {
                this.videoPlayer.nativeElement.currentTime = this.startTime;
            }
        });

        this.videoPlayer.nativeElement.addEventListener('timeupdate', () => {
            this.timeUpdate.emit({
                currentTime: this.videoPlayer.nativeElement.currentTime,
                duration: this.videoPlayer.nativeElement.duration,
            });
        });

        // Surface native MediaError (e.g. unsupported audio/video codec) as a
        // visible overlay instead of leaving the user with a black screen.
        this.videoPlayer.nativeElement.addEventListener('error', () => {
            this.handleMediaError();
        });

        // Track fullscreen state of the host wrapper to swap the FS button icon.
        const updateFs = () => {
            const doc = document as Document & { webkitFullscreenElement?: Element };
            this.isFullscreen = !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
        };
        document.addEventListener('fullscreenchange', updateFs);
        document.addEventListener(
            'webkitfullscreenchange' as keyof DocumentEventMap,
            updateFs,
        );

        // Auto-hide controls (and our overlay buttons) on mouse inactivity.
        // (Mouse/touch listeners are bound from the template so Angular runs
        // change detection automatically.)
        this.notifyActivity();
    }

    /**
     * Listen for component input changes
     * @param changes component changes
     */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['channel'] && changes['channel'].currentValue) {
            this.playChannel(changes['channel'].currentValue);
        }
        if (changes['volume']?.currentValue !== undefined) {
            this.videoPlayer.nativeElement.volume =
                changes['volume'].currentValue;
        }
        if (changes['subtitleUrl'] && !changes['subtitleUrl'].firstChange) {
            this.applySubtitleTrack();
        }
    }

    /**
     * Starts to play the given channel
     * @param channel given channel object
     */
    playChannel(channel: Channel): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.errorMessage = null;
        this.errorHint = null;
        this.hlsRecoveryAttempted = false;
        this.transcodeAttempt = 'none';
        this.currentSourceUrl = null;
        this.silenceCheckAttemptedFor = null;
        this.stopSilenceCheck();
        this.resetVideoElement();

        if (channel.url) {
            const url = channel.url + (channel.epgParams ?? '');
            this.currentSourceUrl = url;
            const effectiveSourceUrl = this.getEffectiveSourceUrl(channel.url);
            const extension = getExtensionFromUrl(effectiveSourceUrl)?.toLowerCase();

            // Set user agent if specified on channel
            if (channel.http?.['user-agent']) {
                this.electronApi?.setUserAgent?.(
                    channel.http['user-agent'],
                    channel.http.referrer
                );
            }

            if (extension === 'm3u8' && Hls && Hls.isSupported()) {
                this.hls = new Hls();
                this.hls.attachMedia(this.videoPlayer.nativeElement);
                this.hls.loadSource(url);
                // Wait for manifest to be parsed before attempting playback;
                // calling play() before HLS.js attaches a MediaSource is a no-op
                // and prevents autoplay from working reliably.
                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.handlePlayOperation();
                });
                this.hls.on(Hls.Events.ERROR, (_event, data) => {
                    this.handleHlsError(data);
                });
            } else if (extension === 'm3u8') {
                this.playNative(url, 'application/x-mpegURL');
            } else if (extension === 'ts') {
                this.playNative(url, 'video/mp2t');
            } else if (extension === 'mp4') {
                this.playNative(url, 'video/mp4');
            } else {
                this.playNative(url);
            }
            // Side-load external subtitle if provided
            this.applySubtitleTrack();
        }
    }

    private getEffectiveSourceUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const nestedUrl = parsed.searchParams.get('url');
            return nestedUrl ? decodeURIComponent(nestedUrl) : url;
        } catch {
            return url;
        }
    }

    private resetVideoElement(): void {
        const videoElement = this.videoPlayer.nativeElement;
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
    }

    private applySubtitleTrack(): void {
        const video = this.videoPlayer.nativeElement;
        // Remove existing side-loaded subtitle tracks
        const existing = video.querySelectorAll('track[data-sideloaded]');
        existing.forEach((t) => t.remove());

        if (!this.subtitleUrl) return;

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.src = this.subtitleUrl;
        track.srclang = 'en';
        track.label = 'Subtitles';
        track.setAttribute('data-sideloaded', '1');
        if (this.showCaptions) {
            track.default = true;
        }
        video.appendChild(track);
    }

    private playNative(url: string, type?: string): void {
        const videoElement = this.videoPlayer.nativeElement;
        if (type) {
            videoElement.setAttribute('type', type);
        } else {
            videoElement.removeAttribute('type');
        }
        videoElement.src = url;
        this.handlePlayOperation();
    }

    /**
     * Disables text based captions based on the global settings
     */
    disableCaptions(): void {
        for (
            let i = 0;
            i < this.videoPlayer.nativeElement.textTracks.length;
            i++
        ) {
            this.videoPlayer.nativeElement.textTracks[i].mode = 'hidden';
        }
    }

    /**
     * Enables subtitle/caption tracks
     */
    enableCaptions(): void {
        const tracks = this.videoPlayer.nativeElement.textTracks;
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].kind === 'subtitles' || tracks[i].kind === 'captions') {
                tracks[i].mode = 'showing';
            }
        }
    }

    /**
     * Handles promise based play operation
     */
    handlePlayOperation(): void {
        const video = this.videoPlayer.nativeElement;
        // Always start unmuted at full volume.
        video.muted = false;
        if (video.volume === 0) {
            video.volume = 1;
        }
        const playPromise = video.play();

        if (playPromise !== undefined) {
            playPromise
                .then(() => {
                    // Automatic playback started!
                    if (!this.showCaptions) {
                        this.disableCaptions();
                    } else {
                        this.enableCaptions();
                    }
                    this.startSilenceCheck();
                })
                .catch(() => {
                    // Autoplay was blocked (rare in Electron when
                    // `autoplayPolicy: 'no-user-gesture-required'` is set).
                    // Leave the video unmuted and let the user press play.
                });
        }
    }

    /**
     * Map a MediaError on the <video> element to a user-friendly overlay.
     * In PWA mode, MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4)
     * are commonly caused by codecs the browser cannot decode (AC-3, E-AC-3,
     * MP2 audio, HEVC video, etc.).
     */
    private handleMediaError(): void {
        const mediaError = this.videoPlayer.nativeElement.error;
        if (!mediaError) return;

        const detail = (mediaError.message || '').toLowerCase();
        const isAudioCodec =
            detail.includes('audio decoder') ||
            detail.includes('audio codec') ||
            detail.includes('unsupportedconfig');
        const isVideoCodec =
            detail.includes('video decoder') || detail.includes('video codec');
        const isPwa =
            typeof window !== 'undefined' &&
            !(window as unknown as { electron?: unknown }).electron;

        // For decode / unsupported-source errors, try to recover by routing
        // through the proxy's /transcode endpoint (FFmpeg server-side transcode).
        if (mediaError.code === 3 || mediaError.code === 4) {
            const reason = isAudioCodec
                ? 'audio'
                : isVideoCodec
                  ? 'video'
                  : 'unknown';
            if (this.tryTranscodeRetry(reason)) {
                return; // overlay stays hidden; we're attempting recovery
            }
        }

        switch (mediaError.code) {
            case 1: // MEDIA_ERR_ABORTED
                // User-initiated abort — don't show an error.
                return;
            case 2: // MEDIA_ERR_NETWORK
                this.errorMessage =
                    'Network error while loading the stream.';
                this.errorHint =
                    'Check your connection and try a different channel or playlist.';
                break;
            case 3: // MEDIA_ERR_DECODE
            case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
                if (isAudioCodec) {
                    this.errorMessage =
                        "This channel's audio codec is not supported by your browser.";
                    this.errorHint = isPwa
                        ? 'Common cause: AC-3 / E-AC-3 / MP2 audio. Try the desktop (Electron) app, which includes broader codec support.'
                        : 'Try a different channel or an external player (MPV / VLC) from settings.';
                } else if (isVideoCodec) {
                    this.errorMessage =
                        "This channel's video codec is not supported by your browser.";
                    this.errorHint = isPwa
                        ? 'Common cause: HEVC/H.265. Try the desktop app or pick a different channel.'
                        : 'Try an external player (MPV / VLC) from settings.';
                } else {
                    this.errorMessage =
                        'This stream could not be played in the browser.';
                    this.errorHint = isPwa
                        ? 'Some IPTV streams use codecs (AC-3, HEVC) that browsers cannot decode. Try the desktop app.'
                        : 'Try a different channel or an external player from settings.';
                }
                break;
            default:
                this.errorMessage = 'Playback failed.';
                this.errorHint = mediaError.message || null;
        }
    }

    /**
     * Handle errors reported by HLS.js. For fatal media errors we attempt
     * one in-place recovery (swapAudioCodec + recoverMediaError) before
     * giving up and showing the error overlay.
     */
    private handleHlsError(data: { fatal?: boolean; type?: string; details?: string }): void {
        if (!data?.fatal) return;
        if (!this.hls) return;

        const type = data.type;
        // Hls.ErrorTypes: 'networkError' | 'mediaError' | 'muxError' | 'otherError'
        if (type === 'mediaError' && !this.hlsRecoveryAttempted) {
            this.hlsRecoveryAttempted = true;
            try {
                this.hls.swapAudioCodec();
                this.hls.recoverMediaError();
                return;
            } catch {
                // Fall through to transcode retry / error overlay
            }
        }

        // Try server-side transcode as a recovery path for media errors
        // (typical cause: codecs the browser cannot decode).
        if (type === 'mediaError') {
            const details = (data.details || '').toLowerCase();
            const reason = details.includes('audio')
                ? 'audio'
                : details.includes('video')
                  ? 'video'
                  : 'unknown';
            if (this.tryTranscodeRetry(reason)) {
                return;
            }
        }

        const isPwa =
            typeof window !== 'undefined' &&
            !(window as unknown as { electron?: unknown }).electron;

        if (type === 'networkError') {
            this.errorMessage = 'Network error while loading the stream.';
            this.errorHint =
                data.details || 'Check your connection and try again.';
        } else if (type === 'mediaError') {
            this.errorMessage =
                'This stream could not be decoded by the browser.';
            this.errorHint = isPwa
                ? 'Some IPTV streams use codecs (AC-3, HEVC) that browsers cannot decode. Try the desktop app.'
                : data.details || null;
        } else {
            this.errorMessage = 'Playback failed.';
            this.errorHint = data.details || null;
        }
    }

    /**
     * Attempt to recover from a codec/decode error by switching the source to
     * the proxy's /transcode endpoint (FFmpeg-based server-side transcoding).
     *
     * Strategy:
     *   1. First retry  — audio-only transcode (copies video, transcodes audio
     *      to AAC). Handles AC-3 / E-AC-3 / MP2 audio which browsers can't decode.
     *   2. Second retry — full transcode (H.264 + AAC). Handles HEVC and other
     *      video codecs the browser doesn't support.
     *   3. After both fail, give up and let the error overlay show.
     *
     * Returns true if a retry was started, false if no further retry is possible.
     */
    private tryTranscodeRetry(reason: 'audio' | 'video' | 'unknown'): boolean {
        if (!this.currentSourceUrl) return false;

        let nextMode: 'audio' | 'full';
        if (this.transcodeAttempt === 'none') {
            nextMode = reason === 'video' ? 'full' : 'audio';
        } else if (this.transcodeAttempt === 'audio') {
            nextMode = 'full';
        } else {
            return false; // already at 'full' — nothing more to try
        }

        const transcodeUrl = this.toTranscodeUrl(
            this.currentSourceUrl,
            nextMode
        );
        if (!transcodeUrl) return false;

        this.transcodeAttempt = nextMode;
        // Clear any previous error state so the overlay disappears during retry.
        this.errorMessage = null;
        this.errorHint = null;

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.resetVideoElement();
        // Transcoded output is fragmented MP4 — play it natively.
        this.playNative(transcodeUrl, 'video/mp4');
        return true;
    }

    /**
     * Rewrite a proxied stream URL (`http://host/stream?url=…`) to its
     * `/transcode` equivalent. Returns null if the URL is not a proxy URL
     * (in which case transcoding cannot be used).
     */
    private toTranscodeUrl(
        streamUrl: string,
        mode: 'audio' | 'full'
    ): string | null {
        try {
            const u = new URL(streamUrl, window.location.origin);
            if (!/\/stream$/.test(u.pathname) && !/\/transcode$/.test(u.pathname)) {
                return null;
            }
            u.pathname = u.pathname
                .replace(/\/stream$/, '/transcode')
                .replace(/\/transcode$/, '/transcode');
            if (mode === 'full') {
                u.searchParams.set('reencode', 'full');
            } else {
                u.searchParams.delete('reencode');
            }
            return u.toString();
        } catch {
            return null;
        }
    }

    /**
     * Save volume when user changes it
     */
    onVolumeChange(): void {
        const currentVolume = this.videoPlayer.nativeElement.volume;
        localStorage.setItem('volume', currentVolume.toString());
    }

    /**
     * Audio silence detection. Some streams (e.g. AC-3 / E-AC-3 / DTS in
     * MP4/MKV) have a video codec Chromium can decode but an audio codec it
     * cannot, resulting in silent playback with no error. After ~4s of strictly
     * silent samples we retry the current source through the local stream
     * proxy with `transcode=audio` (preserves video codec, transcodes audio
     * to AAC). Guarded per-source so it won't loop.
     */
    private startSilenceCheck(): void {
        const video = this.videoPlayer?.nativeElement;
        if (!video) return;
        const sourceUrl = this.currentSourceUrl;
        if (!sourceUrl) return;
        // Already retried (or actively checking) this source — bail.
        if (this.silenceCheckAttemptedFor === sourceUrl) return;
        // Already routing through an audio-only transcode — no further recovery.
        if (
            sourceUrl.includes('transcode=audio') ||
            sourceUrl.includes('transcode=1')
        ) {
            return;
        }
        // Only available in Electron where the proxy can do the transcoding.
        if (!this.electronApi?.getStreamProxyPort) return;

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
            const src = ctx.createMediaElementSource(video);
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
                    const delta = Math.abs(buffer[i] - 128);
                    if (delta > peak) peak = delta;
                }
                this.silenceSamples.push(peak);

                // Sample for ~4s at 250ms intervals.
                if (this.silenceSamples.length >= 16) {
                    const maxPeak = Math.max(...this.silenceSamples);
                    this.stopSilenceCheck();
                    if (maxPeak === 0) {
                        console.warn(
                            '[HtmlVideoPlayer] No audio detected for 4s — retrying with audio-only transcode'
                        );
                        void this.retryWithAudioTranscode(sourceUrl);
                    }
                    return;
                }
                this.silenceCheckTimer = setTimeout(sample, 250);
            };
            // Skip the first ~750ms so the decoder can start producing samples.
            this.silenceCheckTimer = setTimeout(sample, 750);
        } catch (e) {
            console.debug(
                '[HtmlVideoPlayer] Web Audio silence check unavailable:',
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
        // NOTE: Do NOT disconnect MediaElementSource here — doing so silences
        // the <video>. We only release the graph on destroy.
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
            const port = await this.electronApi?.getStreamProxyPort?.();
            if (!port) return;
            // If sourceUrl is already proxied, unwrap to the inner target first.
            let target = sourceUrl;
            try {
                const parsed = new URL(sourceUrl);
                const nested = parsed.searchParams.get('url');
                if (nested && parsed.pathname.endsWith('/stream')) {
                    target = nested;
                }
            } catch {
                // not a URL we can parse — use as-is
            }
            const proxyUrl =
                `http://127.0.0.1:${port}/stream?url=${encodeURIComponent(target)}&transcode=audio`;
            this.transcodeAttempt = 'audio';
            this.errorMessage = null;
            this.errorHint = null;
            if (this.hls) {
                this.hls.destroy();
                this.hls = null;
            }
            this.resetVideoElement();
            this.currentSourceUrl = proxyUrl;
            this.playNative(proxyUrl, 'video/mp2t');
        } catch (e) {
            console.warn(
                '[HtmlVideoPlayer] Failed to retry with audio transcode:',
                e instanceof Error ? e.message : String(e)
            );
        }
    }

    /**
     * Destroy hls instance on component destroy and clean up event listener
     */
    ngOnDestroy(): void {
        this.videoPlayer.nativeElement.removeEventListener(
            'volumechange',
            this.onVolumeChange
        );
        if (this.activityTimer) {
            clearTimeout(this.activityTimer);
            this.activityTimer = null;
        }
        this.teardownAudioGraph();
        if (this.hls) {
            this.hls.destroy();
        }
    }
}
