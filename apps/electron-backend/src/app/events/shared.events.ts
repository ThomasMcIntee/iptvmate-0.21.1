import { ipcMain, session } from 'electron';

export default class SharedEvents {
    static bootstrapSharedEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

ipcMain.handle('set-user-agent', (event, userAgent, referer) => {
    setUserAgent(userAgent, referer); // TODO: test if defaults needed
    return true;
});

ipcMain.handle(
    'OPEN_SUBTITLES_REQUEST',
    async (
        _event,
        payload: {
            apiKey: string;
            language: string;
            tmdbId?: string | null;
            season?: number;
            episode?: number;
            title?: string;
            timeoutMs?: number;
        }
    ) => {
        const { apiKey, language, tmdbId, season, episode, title } = payload;
        const timeoutMs = payload.timeoutMs ?? 5000;

        if (!apiKey) {
            return null;
        }

        const isEpisode =
            Number.isFinite(season) && Number.isFinite(episode);
        const attempts: Array<Record<string, string>> = [];

        if (isEpisode) {
            if (tmdbId) {
                attempts.push({
                    tmdb_id: String(tmdbId),
                    languages: language,
                    type: 'episode',
                    season_number: String(season),
                    episode_number: String(episode),
                });
                attempts.push({
                    parent_tmdb_id: String(tmdbId),
                    languages: language,
                    type: 'episode',
                    season_number: String(season),
                    episode_number: String(episode),
                });
            }

            if (title) {
                attempts.push({
                    query: title,
                    languages: language,
                    type: 'episode',
                    season_number: String(season),
                    episode_number: String(episode),
                });
            }
        } else {
            if (tmdbId) {
                attempts.push({
                    tmdb_id: String(tmdbId),
                    languages: language,
                    type: 'movie',
                });
            }

            if (title) {
                attempts.push({
                    query: title,
                    languages: language,
                    type: 'movie',
                });
            }
        }

        for (const searchParams of attempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const searchUrl = new URL(
                    'https://api.opensubtitles.com/api/v1/subtitles'
                );
                Object.entries(searchParams).forEach(([key, value]) => {
                    searchUrl.searchParams.set(key, value);
                });

                const searchRes = await fetch(searchUrl.toString(), {
                    method: 'GET',
                    headers: {
                        'Api-Key': apiKey,
                        'User-Agent': 'iptvmate v1',
                        Accept: 'application/json',
                    },
                    signal: controller.signal,
                });

                if (!searchRes.ok) {
                    continue;
                }

                const searchData = (await searchRes.json()) as {
                    data?: Array<{
                        attributes?: {
                            files?: Array<{ file_id?: number }>;
                        };
                    }>;
                };

                const fileId =
                    searchData?.data?.[0]?.attributes?.files?.[0]?.file_id;
                if (!fileId) {
                    continue;
                }

                const downloadRes = await fetch(
                    'https://api.opensubtitles.com/api/v1/download',
                    {
                        method: 'POST',
                        headers: {
                            'Api-Key': apiKey,
                            'User-Agent': 'iptvmate v1',
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            file_id: fileId,
                            sub_format: 'webvtt',
                        }),
                        signal: controller.signal,
                    }
                );

                if (!downloadRes.ok) {
                    continue;
                }

                const downloadData = (await downloadRes.json()) as {
                    link?: string;
                };
                if (downloadData?.link) {
                    // Fetch the actual VTT text so the renderer can use a
                    // same-origin data URL on the <track> element (avoids
                    // CORS blocking on cross-origin subtitle CDNs).
                    try {
                        const vttRes = await fetch(downloadData.link, {
                            method: 'GET',
                            headers: { 'User-Agent': 'iptvmate v1' },
                            signal: controller.signal,
                        });
                        if (vttRes.ok) {
                            const text = await vttRes.text();
                            const base64 = Buffer.from(text, 'utf-8').toString(
                                'base64'
                            );
                            return `data:text/vtt;charset=utf-8;base64,${base64}`;
                        }
                    } catch {
                        // Fall back to returning the raw link below.
                    }
                    return downloadData.link;
                }
            } catch {
                // Try the next lookup strategy.
            } finally {
                clearTimeout(timeout);
            }
        }

        return null;
    }
);

/**
 * Sets the user agent header for all http requests
 * @param userAgent user agent to use
 * @param referer referer to use
 */
export function setUserAgent(userAgent: string, referer?: string): void {
    if (!userAgent) {
        return; // Exit early if no user agent provided
    }

    // Remove trailing slash from referer if it exists
    let originURL: string;
    if (referer?.endsWith('/')) {
        originURL = referer.slice(0, -1);
    }

    session.defaultSession.webRequest.onBeforeSendHeaders(
        (details, callback) => {
            details.requestHeaders['User-Agent'] = userAgent;
            details.requestHeaders['Referer'] = referer as string;
            details.requestHeaders['Origin'] = originURL as string;
            callback({ requestHeaders: details.requestHeaders });
        }
    );
    console.log(`Success: Set "${userAgent}" as user agent header`);
}
