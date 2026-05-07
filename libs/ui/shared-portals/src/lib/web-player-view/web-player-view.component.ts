import {
    Component,
    EventEmitter,
    Output,
    Signal,
    ViewEncapsulation,
    effect,
    inject,
    input,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { StorageMap } from '@ngx-pwa/local-storage';
import {
    ArtPlayerComponent,
    HtmlVideoPlayerComponent,
    VjsPlayerComponent,
} from 'components';
import { getExtensionFromUrl } from 'm3u-utils';
import { STORE_KEY, Settings, VideoPlayer } from 'shared-interfaces';

@Component({
    selector: 'app-web-player-view',
    templateUrl: './web-player-view.component.html',
    styleUrls: ['./web-player-view.component.scss'],
    imports: [ArtPlayerComponent, HtmlVideoPlayerComponent, VjsPlayerComponent],
    encapsulation: ViewEncapsulation.None,
})
export class WebPlayerViewComponent {
    storage = inject(StorageMap);
    private streamVersion = 0;
    private static readonly XTREAM_TS_SUFFIX_REGEX = /\.ts(?=$|[?#])/i;
    private static readonly XTREAM_M3U8_SUFFIX_REGEX = /\.m3u8(?=$|[?#])/i;
    private static readonly PWA_PROXY_CANDIDATES = [
        'http://localhost:3000',
        'http://localhost:3333',
        'http://localhost:7333',
    ];
    private static readonly PWA_PROXY_HEALTH_PATH = '/health';
    /** Resolved once a working backend is found; null until then, reset on failure so next call retries. */
    private static pwaProxyBaseCache: string | null = null;
    private static pwaProbeInProgress: Promise<string | null> | null = null;

    streamUrl = input.required<string>();
    streamHeaders = input<
        { userAgent?: string; referrer?: string; origin?: string } | undefined
    >(undefined);
    startTime = input<number>(0);
    subtitleUrl = input<string | null>(null);
    @Output() timeUpdate = new EventEmitter<{
        currentTime: number;
        duration: number;
    }>();

    settings = toSignal(
        this.storage.get(STORE_KEY.Settings)
    ) as Signal<Settings>;

    get showCaptions(): boolean {
        return this.settings()?.showCaptions ?? false;
    }

    channel!: { url: string };
    player!: VideoPlayer;
    vjsOptions!: { sources: { src: string; type?: string }[] };
    forceVideoJsFallback = false;
    forceHtml5Fallback = false;
    private readonly streamUrlEffect = effect(() => {
        this.player = this.settings()?.player ?? VideoPlayer.VideoJs;
        this.forceVideoJsFallback = false;
        this.forceHtml5Fallback = false;

        const streamUrl = this.streamUrl();
        if (!streamUrl) {
            return;
        }

        const effectiveSource = this.getEffectiveSourceUrl(streamUrl).toLowerCase();
        const extension = getExtensionFromUrl(effectiveSource)?.toLowerCase();
        const isLiveLike =
            effectiveSource.includes('/live/') ||
            extension === 'm3u8' ||
            extension === 'm3u' ||
            extension === 'ts';
        const isProxied = streamUrl.includes('/stream?url=');

        // For proxied VOD/series, prefer the plain HTML5 element in browser mode.
        // This avoids player-layer regressions where Video.js/ArtPlayer can render audio-only.
        if (isProxied && !isLiveLike) {
            this.forceHtml5Fallback = true;
        } else if (this.player === VideoPlayer.ArtPlayer && isLiveLike) {
            this.forceVideoJsFallback = false;
        }

        void this.applyStreamUrl(streamUrl);
    });

    private async applyStreamUrl(streamUrl: string): Promise<void> {
        const currentVersion = ++this.streamVersion;
        const alternateLiveUrl = this.getAlternateLiveUrl(streamUrl);

        const resolvedStreamUrl = await this.getPlayableUrl(streamUrl);

        if (currentVersion !== this.streamVersion) {
            return;
        }

        if (
            (this.player === VideoPlayer.ArtPlayer ||
                this.player === VideoPlayer.Html5Player) &&
            alternateLiveUrl
        ) {
            const resolvedAlternateLive = await this.getPlayableUrl(alternateLiveUrl);
            if (currentVersion !== this.streamVersion) {
                return;
            }
            this.setChannel(resolvedAlternateLive);
        } else {
            this.setChannel(resolvedStreamUrl);
        }

        if (
            this.player === VideoPlayer.VideoJs ||
            this.player === VideoPlayer.ArtPlayer
        ) {
            const sources: { src: string; type?: string }[] = [];

            if (alternateLiveUrl) {
                const resolvedAlternateLive = await this.getPlayableUrl(alternateLiveUrl);
                if (currentVersion !== this.streamVersion) {
                    return;
                }
                sources.push(this.buildVjsSource(resolvedAlternateLive, alternateLiveUrl));
            }

            sources.push(this.buildVjsSource(resolvedStreamUrl, streamUrl));
            this.vjsOptions = { sources };
        }
    }

    onArtPlayerPlaybackError(): void {
        const source = this.streamUrl()?.toLowerCase() ?? '';
        if (source.includes('/live/')) {
            this.forceVideoJsFallback = true;
        }
    }

    private getAlternateLiveUrl(streamUrl: string): string | null {
        const buildAlternateUrl = (targetUrl: string): string | null => {
            const source = targetUrl.toLowerCase();
            if (!source.includes('/live/')) {
                return null;
            }

            if (WebPlayerViewComponent.XTREAM_TS_SUFFIX_REGEX.test(source)) {
                return targetUrl.replace(
                    WebPlayerViewComponent.XTREAM_TS_SUFFIX_REGEX,
                    '.m3u8'
                );
            }

            if (WebPlayerViewComponent.XTREAM_M3U8_SUFFIX_REGEX.test(source)) {
                return targetUrl.replace(
                    WebPlayerViewComponent.XTREAM_M3U8_SUFFIX_REGEX,
                    '.ts'
                );
            }

            if (!source.includes('/live/play/')) {
                return null;
            }

            try {
                const parsed = new URL(targetUrl);
                const parts = parsed.pathname.split('/');
                const last = parts[parts.length - 1] ?? '';
                if (!last || last.includes('.')) {
                    return null;
                }
                parts[parts.length - 1] = `${last}.m3u8`;
                parsed.pathname = parts.join('/');
                return parsed.toString();
            } catch {
                return null;
            }
        };

        try {
            const parsed = new URL(streamUrl);
            const nestedUrl = parsed.searchParams.get('url');
            if (nestedUrl) {
                const decodedNestedUrl = decodeURIComponent(nestedUrl);
                const alternateNestedUrl = buildAlternateUrl(decodedNestedUrl);
                if (!alternateNestedUrl) {
                    return null;
                }
                parsed.searchParams.set('url', alternateNestedUrl);
                return parsed.toString();
            }
        } catch {
            // Fall back to direct URL handling below.
        }

        return buildAlternateUrl(streamUrl);
    }

    private buildVjsSource(
        streamUrl: string,
        sourceUrlForType?: string
    ): { src: string; type?: string } {
        const sourceUrl = sourceUrlForType ?? streamUrl;
        const sourceHint = sourceUrl.toLowerCase();
        const effectiveSource = this.getEffectiveSourceUrl(sourceUrl).toLowerCase();
        const extension = getExtensionFromUrl(effectiveSource);
        const isLiveLike =
            effectiveSource.includes('/live/') ||
            effectiveSource.includes('/live/play/');
        const isProxied = sourceHint.includes('/stream?url=');

        // Only force MIME when confidently known. For unknown live URLs,
        // leaving type undefined allows Video.js/native tech to inspect response headers.
        let mimeType: string | undefined;
        if (extension === 'm3u' || extension === 'm3u8') {
            mimeType = 'application/x-mpegURL';
        } else if (extension === 'ts' || sourceHint.includes('/live/play/')) {
            mimeType = 'video/mp2t';
        } else if (extension === 'mp4' || sourceHint.includes('.mp4')) {
            mimeType = 'video/mp4';
        } else if (!isLiveLike && !isProxied) {
            // For VOD/series with opaque URLs, mp4 fallback improves compatibility.
            mimeType = 'video/mp4';
        }

        return { src: streamUrl, type: mimeType };
    }

    private getEffectiveSourceUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const nestedUrl = parsed.searchParams.get('url');
            if (nestedUrl) {
                return decodeURIComponent(nestedUrl);
            }
        } catch {
            return url;
        }

        return url;
    }

    private async resolvePwaProxyBase(): Promise<string | null> {
        const healthPath = WebPlayerViewComponent.PWA_PROXY_HEALTH_PATH;

        // Validate cached proxy base first; if stale, clear it and re-probe.
        if (WebPlayerViewComponent.pwaProxyBaseCache) {
            try {
                const response = await fetch(
                    `${WebPlayerViewComponent.pwaProxyBaseCache}${healthPath}`
                );
                if (response.ok) {
                    return WebPlayerViewComponent.pwaProxyBaseCache;
                }
            } catch {
                WebPlayerViewComponent.pwaProxyBaseCache = null;
            }
        }

        // Deduplicate concurrent calls while a probe is in flight.
        if (!WebPlayerViewComponent.pwaProbeInProgress) {
            WebPlayerViewComponent.pwaProbeInProgress = (async () => {
                const override = (globalThis as {
                    __iptvmateProxyBase?: string;
                }).__iptvmateProxyBase;
                const candidates = Array.from(
                    new Set([
                        ...(override ? [override] : []),
                        ...WebPlayerViewComponent.PWA_PROXY_CANDIDATES,
                    ])
                );

                for (const candidate of candidates) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 2000);
                        const response = await fetch(`${candidate}${healthPath}`, {
                            signal: controller.signal,
                        });
                        clearTimeout(timeoutId);
                        if (response.ok) {
                            WebPlayerViewComponent.pwaProxyBaseCache = candidate;
                            return candidate;
                        }
                    } catch {
                        // Try the next candidate.
                    }
                }

                // All candidates failed — reset so next call retries.
                WebPlayerViewComponent.pwaProbeInProgress = null;
                return null;
            })();
        }

        return WebPlayerViewComponent.pwaProbeInProgress;
    }

    private async getPlayableUrl(streamUrl: string): Promise<string> {
        if (!/^https?:\/\//i.test(streamUrl)) {
            return streamUrl;
        }

        // Only proxy live/HLS-like URLs. Keep VOD/series direct to avoid
        // unnecessary proxy interference with providers that already serve them correctly.
        const sourceHint = streamUrl.toLowerCase();
        const extension = getExtensionFromUrl(streamUrl)?.toLowerCase();
        const shouldProxy =
            sourceHint.includes('/live/') ||
            extension === 'm3u8' ||
            extension === 'm3u' ||
            extension === 'ts';
        if (!shouldProxy) {
            return streamUrl;
        }

        const electronApi = (globalThis as {
            electron?: { getStreamProxyPort?: () => Promise<number> };
        }).electron;

        if (!electronApi?.getStreamProxyPort) {
            // PWA mode: find a backend that actually exposes /stream.
            const proxyBase = await this.resolvePwaProxyBase();
            if (!proxyBase) {
                return streamUrl;
            }
            return this.buildProxyStreamUrl(proxyBase, streamUrl);
        }

        try {
            const port = await electronApi.getStreamProxyPort();
            if (!port) {
                return streamUrl;
            }
            return this.buildProxyStreamUrl(`http://127.0.0.1:${port}`, streamUrl);
        } catch {
            return streamUrl;
        }
    }

    private buildProxyStreamUrl(proxyBase: string, streamUrl: string): string {
        const params = new URLSearchParams({ url: streamUrl });
        const headers = this.streamHeaders();

        if (headers?.userAgent) {
            params.set('ua', headers.userAgent);
        }
        if (headers?.referrer) {
            params.set('ref', headers.referrer);
        }
        if (headers?.origin) {
            params.set('org', headers.origin);
        }

        return `${proxyBase}/stream?${params.toString()}`;
    }

    setChannel(streamUrl: string) {
        this.channel = {
            url: streamUrl,
        };
    }
}