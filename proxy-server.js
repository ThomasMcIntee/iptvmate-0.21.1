/**
 * Local proxy server for iptvmate PWA browser mode.
 * Handles CORS and forwards requests to Xtream/Stalker providers and parses M3U playlists.
 * Uses only packages already present in node_modules.
 *
 * Usage: node proxy-server.js [port]
 * Default port: 3000
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { spawn } = require('child_process');

// FFmpeg binary path. Prefer the bundled @ffmpeg-installer build (deterministic
// across machines), fall back to system PATH if unavailable.
let FFMPEG_PATH;
try {
    FFMPEG_PATH = require('@ffmpeg-installer/ffmpeg').path;
} catch {
    FFMPEG_PATH = 'ffmpeg';
}

// Permissive TLS options for IPTV providers with legacy SSL/TLS configurations.
// Many IPTV CDNs use older cipher suites or TLS versions that Node.js rejects by default.
const PERMISSIVE_TLS_OPTIONS = {
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT:@SECLEVEL=0',
};
const { parse: parseM3u } = require('./node_modules/iptv-playlist-parser/src/index.js');
const { randomUUID } = require('node:crypto');
const uuidv4 = () => randomUUID();

// Inlined from libs/shared/m3u-utils (avoids workspace import resolution issues)
function getFilenameFromUrl(value) {
    if (value && value.length > 1) {
        return value.substring(value.lastIndexOf('/') + 1);
    }
    return 'Untitled playlist';
}

function createPlaylistObject(name, playlist, urlOrPath, uploadType) {
    return {
        _id: uuidv4(),
        filename: name,
        title: name,
        count: playlist.items.length,
        playlist: {
            ...playlist,
            items: playlist.items.map((item) => ({ ...item, id: uuidv4() })),
        },
        importDate: new Date().toISOString(),
        lastUsage: new Date().toISOString(),
        favorites: [],
        autoRefresh: false,
        ...(uploadType === 'URL' ? { url: urlOrPath } : {}),
        ...(uploadType === 'FILE' ? { filePath: urlOrPath } : {}),
    };
}

// Lazy-load axios from node_modules
let axios;
try {
    axios = require('./node_modules/axios/dist/node/axios.cjs');
} catch {
    axios = require('./node_modules/axios');
}

const PORT = parseInt(process.argv[2] ?? '3000', 10);

// ─── helpers ─────────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
}

function corsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function parseQuery(rawQuery) {
    return Object.fromEntries(new URLSearchParams(rawQuery));
}

// ─── route handlers ───────────────────────────────────────────────────────────

/**
 * GET /xtream?url=<server>&username=<u>&password=<p>&action=<action>&...
 * Proxies to Xtream player_api.php and wraps response in { payload: ... }
 */
async function handleXtream(query, res) {
    const { url, ...params } = query;
    if (!url) return sendJson(res, 400, { error: 'Missing url param' });

    try {
        const apiUrl = new URL(`${url}/player_api.php`);
        Object.entries(params).forEach(([k, v]) => apiUrl.searchParams.append(k, v));

        const response = await axios.get(apiUrl.toString(), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
            timeout: 30000,
            validateStatus: (s) => s < 500,
            httpsAgent: new https.Agent(PERMISSIVE_TLS_OPTIONS),
        });

        if (response.status >= 400) {
            return sendJson(res, response.status, { error: response.statusText });
        }
        sendJson(res, 200, { payload: response.data });
    } catch (err) {
        console.error('[/xtream] Error:', err.message);
        sendJson(res, 500, { error: err.message });
    }
}

/**
 * GET /parse?url=<m3u_url>
 * Fetches M3U/M3U8 playlist and returns parsed Playlist object.
 */
async function handleParse(query, res) {
    const { url } = query;
    if (!url) return sendJson(res, 400, { error: 'Missing url param' });

    try {
        const agent = new https.Agent(PERMISSIVE_TLS_OPTIONS);
        const result = await axios.get(url, {
            httpsAgent: agent,
            timeout: 30000,
            responseType: 'text',
        });

        const parsedPlaylist = parseM3u(result.data);
        const extractedName = url && url.length > 1 ? getFilenameFromUrl(url) : '';
        const playlistName =
            !extractedName || extractedName === 'Untitled playlist'
                ? 'Imported from URL'
                : extractedName;

        const playlistObject = createPlaylistObject(playlistName, parsedPlaylist, url, 'URL');
        sendJson(res, 200, playlistObject);
    } catch (err) {
        console.error('[/parse] Error:', err.message);
        sendJson(res, 500, { error: err.message });
    }
}

/**
 * GET /stalker?url=<server>&macAddress=<mac>&action=<action>&...
 * Proxies to Stalker portal with proper cookies/headers, wraps in { payload: ... }
 */
async function handleStalker(query, res) {
    const { url, macAddress, serialNumber, token, ...params } = query;
    if (!url) return sendJson(res, 400, { error: 'Missing url param' });

    try {
        const urlObject = new URL(url);
        const queryParts = [];
        Object.entries(params).forEach(([key, value]) => {
            if (key === 'cmd') {
                queryParts.push(`${key}=${String(value)}`);
            } else {
                queryParts.push(`${key}=${encodeURIComponent(String(value))}`);
            }
        });
        if (!params['JsHttpRequest']) {
            queryParts.push('JsHttpRequest=1-xml');
        }

        const fullUrl = `${urlObject.origin}${urlObject.pathname}?${queryParts.join('&')}`;

        let cookieString = `mac=${macAddress ?? ''}; stb_lang=de_DE; timezone=Europe/Berlin`;
        if (serialNumber) {
            cookieString += `; __cfduid=${serialNumber.toLowerCase()}e030245495acd6ebfc1`;
        }

        const headers = {
            Cookie: cookieString,
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250',
            'X-User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250',
            Accept: '*/*',
            Connection: 'keep-alive',
            'Accept-Language': 'en-US,en;q=0.9',
        };
        if (serialNumber) headers['SN'] = serialNumber;
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const isCreateLink = params.action === 'create_link';
        const response = await axios.get(fullUrl, {
            headers,
            timeout: isCreateLink ? 30000 : 15000,
            validateStatus: (s) => s < 500,
            httpsAgent: new https.Agent(PERMISSIVE_TLS_OPTIONS),
        });

        if (response.status >= 400) {
            return sendJson(res, response.status, { error: response.statusText });
        }
        sendJson(res, 200, { payload: response.data });
    } catch (err) {
        console.error('[/stalker] Error:', err.message);
        sendJson(res, 500, { error: err.message });
    }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

// ─── stream proxy ─────────────────────────────────────────────────────────────

const M3U8_CONTENT_TYPES = [
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'audio/mpegurl',
];

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const VOD_REDIRECT_CACHE_TTL_MS = 2 * 60 * 1000;
const vodRedirectCache = new Map();

function resolveHttpTarget(rawUrl, base) {
    try {
        const resolved = base ? new URL(rawUrl, base) : new URL(rawUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            return resolved.toString();
        }
    } catch { /* ignore invalid URLs */ }
    return null;
}

function isVodLikeUrl(value) {
    const lower = value.toLowerCase();
    return (
        lower.includes('/movie/') ||
        lower.includes('/series/') ||
        lower.endsWith('.mp4') ||
        lower.includes('.mp4?') ||
        lower.endsWith('.mkv') ||
        lower.includes('.mkv?')
    );
}

function getCachedVodRedirect(originalUrl) {
    const cached = vodRedirectCache.get(originalUrl);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
        vodRedirectCache.delete(originalUrl);
        return null;
    }
    return cached.targetUrl;
}

function setCachedVodRedirect(originalUrl, targetUrl) {
    vodRedirectCache.set(originalUrl, {
        targetUrl,
        expiresAt: Date.now() + VOD_REDIRECT_CACHE_TTL_MS,
    });
}

function rewriteM3u8(content, proxyBase, manifestUrl, passthroughParams) {
    const buildProxyUrl = (target) => {
        const params = new URLSearchParams(passthroughParams);
        params.set('url', target);
        return `${proxyBase}?${params.toString()}`;
    };

    return content
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) {
                return line.replace(/URI="([^"]+)"/g, (_m, rawUri) => {
                    const target = resolveHttpTarget(rawUri, manifestUrl);
                    if (!target) return `URI="${rawUri}"`;
                    return `URI="${buildProxyUrl(target)}"`;
                });
            }
            if (!trimmed) return line;
            const target = resolveHttpTarget(trimmed, manifestUrl);
            if (target) return buildProxyUrl(target);
            return line;
        })
        .join('\n');
}

function handleStream(req, res) {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const targetUrl = parsed.searchParams.get('url');
    const userAgent = parsed.searchParams.get('ua');
    const referer = parsed.searchParams.get('ref');
    const origin = parsed.searchParams.get('org');
    const passthroughParams = new URLSearchParams();
    if (userAgent) passthroughParams.set('ua', userAgent);
    if (referer) passthroughParams.set('ref', referer);
    if (origin) passthroughParams.set('org', origin);

    if (!targetUrl) {
        res.writeHead(400);
        res.end('Missing url parameter');
        return;
    }

    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        res.writeHead(400);
        res.end('Invalid URL');
        return;
    }

    console.log(
        `[stream] -> ${target.protocol}//${target.host}${target.pathname}`
    );

    const skipHeaders = new Set(['host', 'origin', 'referer']);
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!skipHeaders.has(k.toLowerCase()) && v !== undefined) {
            forwardHeaders[k] = v;
        }
    }

    const createRequest = (currentTarget, redirectCount, originalUrl) => {
        const isHttps = currentTarget.protocol === 'https:';
        const transport = isHttps ? https : http;
        const targetOrigin = `${currentTarget.protocol}//${currentTarget.host}`;
        const normalizedHeaders = Object.fromEntries(
            Object.entries(forwardHeaders).map(([k, v]) => [k.toLowerCase(), v])
        );

        // IPTV providers often require browser-like headers and same-origin referer/origin.
        if (!normalizedHeaders['user-agent']) {
            forwardHeaders['user-agent'] =
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        }
        if (!normalizedHeaders['accept']) {
            forwardHeaders['accept'] =
                'application/vnd.apple.mpegurl, application/x-mpegURL, video/*, */*;q=0.8';
        }
        if (!normalizedHeaders['referer']) {
            forwardHeaders['referer'] = `${targetOrigin}/`;
        }
        if (!normalizedHeaders['origin']) {
            forwardHeaders['origin'] = targetOrigin;
        }

        if (userAgent) {
            forwardHeaders['user-agent'] = userAgent;
        }
        if (referer) {
            forwardHeaders['referer'] = referer;
        }
        if (origin) {
            forwardHeaders['origin'] = origin;
        }

        const options = {
            hostname: currentTarget.hostname,
            port: currentTarget.port
                ? parseInt(currentTarget.port)
                : isHttps ? 443 : 80,
            path: currentTarget.pathname + currentTarget.search,
            method: req.method || 'GET',
            headers: { ...forwardHeaders, host: currentTarget.host },
            ...(isHttps ? PERMISSIVE_TLS_OPTIONS : {}),
        };

        const proxyReq = transport.request(options, (proxyRes) => {
            const statusCode = proxyRes.statusCode ?? 0;
            const contentType = String(proxyRes.headers['content-type'] || '');
            console.log(
                `[stream] <- ${statusCode} ${currentTarget.host}${currentTarget.pathname} ${contentType}`
            );
            const locationHeader = proxyRes.headers.location;
            const location = typeof locationHeader === 'string'
                ? locationHeader
                : Array.isArray(locationHeader) ? locationHeader[0] : undefined;

            if (REDIRECT_STATUS_CODES.has(statusCode) && location && redirectCount < MAX_REDIRECTS) {
                const nextUrl = resolveHttpTarget(location, currentTarget.toString());
                if (nextUrl) {
                    proxyRes.resume();
                    createRequest(new URL(nextUrl), redirectCount + 1, originalUrl).end();
                    return;
                }
            }

            if (isVodLikeUrl(originalUrl) && currentTarget.toString() !== originalUrl) {
                setCachedVodRedirect(originalUrl, currentTarget.toString());
            }

            const responseHeaders = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (v !== undefined) responseHeaders[k] = v;
            }
            delete responseHeaders['location'];
            responseHeaders['access-control-allow-origin'] = '*';

            const lowerContentType = contentType.toLowerCase();
            const isM3u8 = M3U8_CONTENT_TYPES.some((t) => lowerContentType.includes(t))
                || currentTarget.pathname.toLowerCase().endsWith('.m3u8')
                || currentTarget.pathname.toLowerCase().endsWith('.m3u');

            if (isM3u8) {
                delete responseHeaders['content-length'];
                res.writeHead(statusCode || 200, responseHeaders);
                const chunks = [];
                proxyRes.on('data', (chunk) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const proxyBase = `http://localhost:${PORT}/stream`;
                    const rewritten = rewriteM3u8(
                        body,
                        proxyBase,
                        currentTarget.toString(),
                        passthroughParams
                    );
                    res.end(rewritten);
                });
            } else {
                res.writeHead(statusCode || 200, responseHeaders);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            console.error(`[stream] proxy error for ${currentTarget.host}${currentTarget.pathname}: ${err.code} - ${err.message}`);
            if (!res.headersSent) res.writeHead(502);
            res.end(err.message);
        });

        return proxyReq;
    };

    const originalUrl = target.toString();
    const isVodRequest = isVodLikeUrl(originalUrl);
    const cachedVodTarget = isVodRequest ? getCachedVodRedirect(originalUrl) : null;
    const initialTarget = cachedVodTarget ? new URL(cachedVodTarget) : target;

    if (cachedVodTarget) {
        console.log(`[stream] using cached VOD target for ${target.pathname}`);
    }

    createRequest(initialTarget, 0, originalUrl).end();
}

// ─── /transcode endpoint ──────────────────────────────────────────────────────
//
// Live transcode of upstream IPTV streams to fragmented MP4 (fMP4), enabling
// playback of streams whose codecs the browser cannot decode natively
// (AC-3 / E-AC-3 / MP2 audio, HEVC video, etc.).
//
// Query parameters:
//   url       — upstream stream URL (m3u8 / ts / mp4 / …). REQUIRED.
//   reencode  — "audio" (default): copy video, transcode audio to AAC.
//               "full": re-encode video to H.264 AND audio to AAC.
//
// The audio-only mode is dramatically cheaper on CPU and handles the most
// common IPTV codec issue (AC-3 audio). The "full" mode is used as a second
// retry from the client when video also needs transcoding (e.g. HEVC).
function handleTranscode(req, res) {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const targetUrl = parsed.searchParams.get('url');
    const reencode = parsed.searchParams.get('reencode') || 'audio';

    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
    }

    console.log(`[transcode] -> ${targetUrl} (mode=${reencode})`);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-fflags', '+genpts+discardcorrupt',
        '-rw_timeout', '15000000', // 15s I/O timeout (microseconds)
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-user_agent', 'Mozilla/5.0 (compatible; iptvmate)',
        '-i', targetUrl,
    ];

    if (reencode === 'full') {
        args.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '23',
            '-g', '60',
            '-pix_fmt', 'yuv420p'
        );
    } else {
        args.push('-c:v', 'copy');
    }

    args.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '128k',
        '-ar', '48000',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
    );

    const ff = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let headersSent = false;
    let stderrTail = '';

    ff.stdout.on('data', (chunk) => {
        if (!headersSent) {
            headersSent = true;
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
                'Connection': 'keep-alive',
            });
        }
        if (!res.write(chunk)) {
            ff.stdout.pause();
            res.once('drain', () => ff.stdout.resume());
        }
    });

    ff.stderr.on('data', (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-4096);
        if (/error|fail|invalid|denied|refused|unsupported/i.test(s)) {
            process.stderr.write(`[ffmpeg] ${s}`);
        }
    });

    ff.on('error', (err) => {
        console.error('[transcode] spawn error:', err.message);
        if (!headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('FFmpeg spawn failed: ' + err.message);
        } else {
            res.end();
        }
    });

    ff.on('exit', (code, signal) => {
        console.log(`[transcode] ffmpeg exit code=${code} signal=${signal}`);
        if (!headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(stderrTail || 'FFmpeg transcoding failed');
        } else {
            res.end();
        }
    });

    const cleanup = () => {
        if (!ff.killed) {
            try { ff.kill('SIGKILL'); } catch { /* noop */ }
        }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    corsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const query = parseQuery(parsed.search.slice(1));

    try {
        if (parsed.pathname === '/health') {
            return sendJson(res, 200, { ok: true });
        }
        if (parsed.pathname === '/xtream') return await handleXtream(query, res);
        if (parsed.pathname === '/parse')  return await handleParse(query, res);
        if (parsed.pathname === '/stalker') return await handleStalker(query, res);
        if (parsed.pathname === '/stream') return handleStream(req, res);
        if (parsed.pathname === '/transcode') return handleTranscode(req, res, query);

        sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error('Unhandled error:', err);
        sendJson(res, 500, { error: 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`[iptvmate-proxy] Listening on http://localhost:${PORT}`);
    console.log('  /health  — health check endpoint');
    console.log('  /xtream  — Xtream Codes API proxy');
    console.log('  /parse   — M3U/M3U8 playlist parser');
    console.log('  /stalker — Stalker portal proxy');
    console.log('  /stream  — HLS/stream proxy (SSL bypass)');
    console.log('  /transcode — FFmpeg live transcode to fMP4 (AC-3 / HEVC → AAC / H.264)');
});
