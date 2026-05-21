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
    /** Whether the underlying <video> is currently muted (drives the unmute overlay). */
    isMuted = true;
    /** Whether the player-host wrapper is currently in fullscreen. */
    isFullscreen = false;
    /** Whether the user has been recently active (drives controls visibility). */
    isActive = true;
    private activityTimer: ReturnType<typeof setTimeout> | null = null;

    /** Toggle fullscreen on the .player-host wrapper (so overlays remain visible). */
    toggleFullscreen(): void {
        // In Electron, prefer toggling the BrowserWindow fullscreen (more reliable
        // than HTML5 element fullscreen, which can be quirky inside Electron).
        if (this.electronApi?.toggleFullScreen) {
            this.electronApi.toggleFullScreen()
                .then((next) => {
                    this.isFullscreen = next;
                })
                .catch(() => undefined);
            return;
        }
        const host = this.videoPlayer?.nativeElement?.parentElement as
            | (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
            | null;
        if (!host) return;
        const doc = document as Document & {
            webkitFullscreenElement?: Element;
            webkitExitFullscreen?: () => Promise<void>;
        };
        const inFs = !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
        if (inFs) {
            const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
            exit?.()?.catch(() => undefined);
        } else {
            const req = host.requestFullscreen?.bind(host) ?? host.webkitRequestFullscreen?.bind(host);
            req?.()?.catch(() => undefined);
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
                })
                .catch(() => {
                    // Browser blocked autoplay (common in PWA without prior
                    // user interaction). Retry muted, which is universally
                    // allowed. User can unmute via the controls.
                    try {
                        video.muted = true;
                        const mutedPromise = video.play();
                        if (mutedPromise !== undefined) {
                            mutedPromise.catch(() => {
                                // Still blocked — leave for user to press play
                            });
                        }
                    } catch {
                        // Ignore — user can press play manually
                    }
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
        if (this.hls) {
            this.hls.destroy();
        }
    }
}
