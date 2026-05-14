import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';

// Permissive TLS options for IPTV providers with legacy SSL/TLS configurations.
// Many IPTV CDNs use TLS 1.0/1.1 or old cipher suites that Node.js 18+ rejects by default.
const PERMISSIVE_TLS_OPTIONS: https.RequestOptions = {
    rejectUnauthorized: false,
    minVersion: 'TLSv1' as tls.SecureVersion,
    ciphers: 'DEFAULT:@SECLEVEL=0',
};
import { spawn } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpegPath from 'ffmpeg-static';

const M3U8_CONTENT_TYPES = [
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'audio/mpegurl',
];

const STREAM_PROXY_VERSION = '2026-05-14-r6';
const FFMPEG_STATIC_BIN = typeof ffmpegPath === 'string' ? ffmpegPath : null;
const FFMPEG_INSTALLER_BIN =
    typeof ffmpegInstaller?.path === 'string' ? ffmpegInstaller.path : null;
const FFMPEG_BIN =
    (FFMPEG_STATIC_BIN && fs.existsSync(FFMPEG_STATIC_BIN)
        ? FFMPEG_STATIC_BIN
        : null) ??
    (FFMPEG_INSTALLER_BIN && fs.existsSync(FFMPEG_INSTALLER_BIN)
        ? FFMPEG_INSTALLER_BIN
        : null);
const FFMPEG_SOURCE =
    FFMPEG_BIN === FFMPEG_STATIC_BIN
        ? 'ffmpeg-static'
        : FFMPEG_BIN === FFMPEG_INSTALLER_BIN
          ? '@ffmpeg-installer/ffmpeg'
          : 'none';
const HAS_WORKING_FFMPEG = !!FFMPEG_BIN;
let ffmpegUnavailableLogged = false;

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
                    /URI="([^"]+)"/g,
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

function maybeTranscodeResponse(
    req: IncomingMessage,
    res: ServerResponse,
    proxyRes: IncomingMessage,
    sourceUrl: string
): boolean {
    if (!HAS_WORKING_FFMPEG || !FFMPEG_BIN) {
        if (!ffmpegUnavailableLogged) {
            ffmpegUnavailableLogged = true;
            console.warn(
                `[StreamProxy] ffmpeg binary unavailable (ffmpeg-static=${FFMPEG_STATIC_BIN ?? 'none'}, installer=${FFMPEG_INSTALLER_BIN ?? 'none'}); serving source without transcoding`
            );
        }
        return false;
    }

    const statusCode = proxyRes.statusCode ?? 0;
    if (statusCode < 200 || statusCode >= 300) {
        return false;
    }

    console.log(
        `[StreamProxy] transcoding to H.264/AAC via ${FFMPEG_SOURCE}: ${sourceUrl}`
    );

    const responseHeaders: http.OutgoingHttpHeaders = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'Range, Content-Type',
        'cache-control': 'no-store',
        'content-type': 'video/mp2t',
        'transfer-encoding': 'chunked',
    };

    res.writeHead(200, responseHeaders);

    const ffmpeg = spawn(
        FFMPEG_BIN,
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-probesize',
            '10M',
            '-analyzeduration',
            '20M',
            '-i',
            'pipe:0',
            '-map',
            '0:v:0?',
            '-map',
            '0:a:0?',
            '-sn',
            '-dn',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-profile:v',
            'main',
            '-level:v',
            '4.1',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ac',
            '2',
            '-ar',
            '48000',
            '-max_muxing_queue_size',
            '4096',
            '-muxdelay',
            '0',
            '-muxpreload',
            '0',
            '-f',
            'mpegts',
            'pipe:1',
        ],
        {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        }
    );

    let ffmpegErrorOutput = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
        ffmpegErrorOutput += chunk.toString('utf8');
        if (ffmpegErrorOutput.length > 8000) {
            ffmpegErrorOutput = ffmpegErrorOutput.slice(-8000);
        }
    });

    const terminateFfmpeg = () => {
        if (ffmpeg.killed) {
            return;
        }

        // Give ffmpeg a chance to flush trailer data before forcing termination.
        ffmpeg.kill('SIGTERM');
        setTimeout(() => {
            if (!ffmpeg.killed) {
                ffmpeg.kill('SIGKILL');
            }
        }, 1000);
    };

    req.on('aborted', terminateFfmpeg);
    proxyRes.on('error', terminateFfmpeg);

    ffmpeg.on('error', (error) => {
        console.error('[StreamProxy] ffmpeg spawn failed:', error);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end('Transcoding failed');
        }
    });

    ffmpeg.on('close', (code, signal) => {
        if (signal && (req.aborted || res.writableEnded || res.destroyed)) {
            console.log(
                `[StreamProxy] ffmpeg terminated by ${signal} after client disconnect`
            );
            return;
        }

        if (code !== 0) {
            console.error(
                `[StreamProxy] ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${ffmpegErrorOutput}`
            );
            if (!res.writableEnded) {
                res.end();
            }
            return;
        }

        if (!res.writableEnded) {
            res.end();
        }
    });

    ffmpeg.stdin.on('error', () => {
        // Ignore broken pipe errors when client disconnects.
    });

    proxyRes.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    return true;
}

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
    const shouldTranscode = params.get('transcode') === '1';
    const shouldTranscodeRequest = shouldTranscode && req.method === 'GET';

    if (!targetUrl) {
        res.writeHead(400);
        res.end('Missing url parameter');
        return;
    }

    console.log(
        `[StreamProxy] ${req.method ?? 'GET'} -> ${targetUrl} (transcode=${shouldTranscode ? '1' : '0'})`
    );

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
    if (shouldTranscodeRequest) {
        // Full-file upstream input keeps ffmpeg output stable for progressive playback.
        skipHeaders.add('range');
        skipHeaders.add('if-range');
        // Avoid gzip/br encoded payloads which ffmpeg cannot decode as media bytes.
        skipHeaders.add('accept-encoding');
    }
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
            ...(isHttps ? PERMISSIVE_TLS_OPTIONS : {}),
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

            if (shouldTranscodeRequest) {
                const didStartTranscoding = maybeTranscodeResponse(
                    req,
                    res,
                    proxyRes,
                    currentTarget.toString()
                );
                if (didStartTranscoding) {
                    return;
                }
            }

            const responseHeaders: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (v !== undefined) responseHeaders[k] = v;
            }

            // Avoid leaking redirect targets back to the renderer.
            delete responseHeaders['location'];

            // Allow renderer to use this resource
            responseHeaders['access-control-allow-origin'] = '*';
            responseHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
            responseHeaders['access-control-allow-headers'] = 'Range, Content-Type';

            const contentType = (
                proxyRes.headers['content-type'] || ''
            ).toLowerCase();
            console.log(
                `[StreamProxy] <- ${statusCode} ${contentType || 'unknown'} (content-length: ${proxyRes.headers['content-length'] || 'unknown'}, content-range: ${proxyRes.headers['content-range'] || 'none'})`
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

        proxyReq.on('error', (err: NodeJS.ErrnoException) => {
            console.error(
                `[StreamProxy] proxy error for ${currentTarget.host}${currentTarget.pathname}: ${err.code} - ${err.message}`
            );
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
        if (proxyServer && proxyPort !== null) {
            resolve(proxyPort);
            return;
        }

        if (proxyServer) {
            reject(new Error('Stream proxy server exists without a bound port'));
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
