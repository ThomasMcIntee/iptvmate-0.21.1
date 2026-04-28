import * as http from 'http';
import * as https from 'https';
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

const M3U8_CONTENT_TYPES = [
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'audio/mpegurl',
];

const STREAM_PROXY_VERSION = '2026-04-28-r3';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

function resolveHttpTarget(rawUrl: string, base?: string): string | null {
    try {
        const resolved = base ? new URL(rawUrl, base) : new URL(rawUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            return resolved.toString();
        }
    } catch {
        // Ignore invalid URLs and leave line unchanged.
    }
    return null;
}

/** Rewrite absolute https:// URLs in an m3u8 manifest to go through the local proxy. */
function rewriteM3u8(
    content: string,
    proxyBase: string,
    manifestUrl: string
): string {
    return content
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            // Skip comments and directives (but rewrite URI= attributes in tags)
            if (trimmed.startsWith('#')) {
                // Rewrite URI values inside EXT-X-KEY, EXT-X-MAP etc.
                return line.replace(
                    /URI="([^\"]+)"/g,
                    (_m, rawUri) => {
                        const target = resolveHttpTarget(rawUri, manifestUrl);
                        if (!target) {
                            return `URI="${rawUri}"`;
                        }
                        return `URI="${proxyBase}?url=${encodeURIComponent(target)}"`;
                    }
                );
            }
            // Blank lines
            if (!trimmed) return line;

            const target = resolveHttpTarget(trimmed, manifestUrl);
            if (target) {
                return `${proxyBase}?url=${encodeURIComponent(target)}`;
            }

            return line;
        })
        .join('\n');
}

let proxyPort: number | null = null;
let proxyServer: http.Server | null = null;

function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
    const reqUrl = req.url || '';
    const searchStart = reqUrl.indexOf('?');
    if (searchStart === -1) {
        res.writeHead(400);
        res.end('Missing url parameter');
        return;
    }

    const params = new URLSearchParams(reqUrl.slice(searchStart + 1));
    const targetUrl = params.get('url');

    if (!targetUrl) {
        res.writeHead(400);
        res.end('Missing url parameter');
        return;
    }

    console.log(`[StreamProxy] -> ${targetUrl}`);

    let target: URL;
    try {
        target = new URL(targetUrl);
    } catch {
        res.writeHead(400);
        res.end('Invalid URL');
        return;
    }

    // Forward relevant request headers, but drop host/origin to avoid rejection
    const forwardHeaders: Record<string, string | string[]> = {};
    const skipHeaders = new Set(['host', 'origin', 'referer']);
    for (const [k, v] of Object.entries(req.headers)) {
        if (!skipHeaders.has(k.toLowerCase()) && v !== undefined) {
            forwardHeaders[k] = v;
        }
    }

    const createRequest = (
        currentTarget: URL,
        redirectCount: number
    ): http.ClientRequest => {
        const isHttps = currentTarget.protocol === 'https:';
        const transport: typeof https | typeof http = isHttps ? https : http;

        const options: https.RequestOptions = {
            hostname: currentTarget.hostname,
            port: currentTarget.port
                ? parseInt(currentTarget.port)
                : isHttps
                  ? 443
                  : 80,
            path: currentTarget.pathname + currentTarget.search,
            method: req.method || 'GET',
            headers: {
                ...forwardHeaders,
                host: currentTarget.host,
            },
            rejectUnauthorized: false,
        };

        const proxyReq = transport.request(options, (proxyRes) => {
            const statusCode = proxyRes.statusCode ?? 0;
            const locationHeader = proxyRes.headers.location;
            const location =
                typeof locationHeader === 'string'
                    ? locationHeader
                    : Array.isArray(locationHeader)
                      ? locationHeader[0]
                      : undefined;

            if (
                REDIRECT_STATUS_CODES.has(statusCode) &&
                location &&
                redirectCount < MAX_REDIRECTS
            ) {
                const nextUrl = resolveHttpTarget(location, currentTarget.toString());
                if (nextUrl) {
                    console.log(
                        `[StreamProxy] redirect(${redirectCount + 1}/${MAX_REDIRECTS}) -> ${nextUrl}`
                    );
                    proxyRes.resume();
                    createRequest(new URL(nextUrl), redirectCount + 1).end();
                    return;
                }
            }

            if (REDIRECT_STATUS_CODES.has(statusCode) && location) {
                console.warn(
                    `[StreamProxy] redirect not followed (count=${redirectCount}, location=${location})`
                );
            }

            const responseHeaders: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (v !== undefined) responseHeaders[k] = v;
            }

            // Avoid leaking redirect targets back to the renderer.
            delete responseHeaders['location'];

            // Allow renderer to use this resource
            responseHeaders['access-control-allow-origin'] = '*';

            const contentType = (
                proxyRes.headers['content-type'] || ''
            ).toLowerCase();
            console.log(
                `[StreamProxy] <- ${statusCode} ${contentType || 'unknown'}`
            );
            const isM3u8 = M3U8_CONTENT_TYPES.some((t) =>
                contentType.includes(t)
            );

            if (isM3u8) {
                // Collect the whole manifest, rewrite segment URLs, then send.
                delete responseHeaders['content-length']; // length will change
                res.writeHead(statusCode || 200, responseHeaders);

                const chunks: Buffer[] = [];
                proxyRes.on('data', (chunk) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const proxyBase = `http://127.0.0.1:${proxyPort}/stream`;
                    const rewritten = rewriteM3u8(
                        body,
                        proxyBase,
                        currentTarget.toString()
                    );

                    if (body !== rewritten) {
                        console.log('[StreamProxy] Rewrote m3u8 URLs');
                    }
                    res.end(rewritten);
                });
            } else {
                res.writeHead(statusCode || 200, responseHeaders);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.writeHead(502);
            }
            res.end(err.message);
        });

        return proxyReq;
    };

    const upstreamReq = createRequest(target, 0);
    if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.method !== 'OPTIONS'
    ) {
        req.pipe(upstreamReq);
    } else {
        upstreamReq.end();
    }
}

export function startStreamProxy(): Promise<number> {
    return new Promise((resolve, reject) => {
        if (proxyServer) {
            resolve(proxyPort!);
            return;
        }

        const server = http.createServer(handleProxyRequest);

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            proxyPort = addr.port;
            proxyServer = server;
            console.log(
                `[StreamProxy] Started on port ${proxyPort} (version ${STREAM_PROXY_VERSION})`
            );
            resolve(proxyPort);
        });

        server.on('error', reject);
    });
}

export function getStreamProxyPort(): number | null {
    return proxyPort;
}
