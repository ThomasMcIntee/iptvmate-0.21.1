import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsStore } from './settings-store.service';

interface OpenSubsSearchResult {
    data: Array<{
        attributes: {
            files: Array<{ file_id: number }>;
            language: string;
        };
    }>;
}

interface OpenSubsDownloadResult {
    link: string;
}

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const FETCH_TIMEOUT_MS = 5000;

@Injectable({ providedIn: 'root' })
export class OpenSubtitlesService {
    private readonly http = inject(HttpClient);
    private readonly settingsStore = inject(SettingsStore);

    /**
     * Fetch a WebVTT subtitle URL for a movie or episode.
     * For episodes, pass `season` and `episode`.
     */
    async fetchSubtitleUrl(
        tmdbId?: number | string | null,
        language?: string,
        season?: number,
        episode?: number,
        title?: string
    ): Promise<string | null> {
        const apiKey = this.settingsStore.opensubtitlesApiKey?.();
        if (!apiKey) {
            return null;
        }

        const lang =
            language ?? this.settingsStore.subtitleLanguage?.() ?? 'en';
        const normalizedTmdbId =
            tmdbId !== undefined && tmdbId !== null && String(tmdbId).trim() !== ''
                ? String(tmdbId)
                : null;

        if (window.electron?.openSubtitlesRequest) {
            try {
                return await window.electron.openSubtitlesRequest({
                    apiKey,
                    language: lang,
                    tmdbId: normalizedTmdbId,
                    season,
                    episode,
                    title,
                    timeoutMs: FETCH_TIMEOUT_MS,
                });
            } catch (err) {
                console.warn('[OpenSubtitles] Electron request failed:', err);
                return null;
            }
        }

        try {
            const result = await Promise.race([
                this._doFetch(
                    apiKey,
                    lang,
                    normalizedTmdbId,
                    season,
                    episode,
                    title
                ),
                new Promise<null>((resolve) =>
                    setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)
                ),
            ]);
            return result;
        } catch (err) {
            console.warn('[OpenSubtitles] Failed to fetch subtitle:', err);
            return null;
        }
    }

    private async _doFetch(
        apiKey: string,
        lang: string,
        tmdbId: string | null,
        season?: number,
        episode?: number,
        title?: string
    ): Promise<string | null> {
        const headers = new HttpHeaders({
            'Api-Key': apiKey,
        });

        const isEpisode = season !== undefined && episode !== undefined;
        const attempts: Array<Record<string, string>> = [];

        if (isEpisode) {
            if (tmdbId) {
                attempts.push({
                    tmdb_id: tmdbId,
                    languages: lang,
                    type: 'episode',
                    season_number: season.toString(),
                    episode_number: episode.toString(),
                });
                // Some providers expose a series-level TMDB id for episodes.
                attempts.push({
                    parent_tmdb_id: tmdbId,
                    languages: lang,
                    type: 'episode',
                    season_number: season.toString(),
                    episode_number: episode.toString(),
                });
            }
            if (title) {
                attempts.push({
                    query: title,
                    languages: lang,
                    type: 'episode',
                    season_number: season.toString(),
                    episode_number: episode.toString(),
                });
            }
        } else {
            if (tmdbId) {
                attempts.push({
                    tmdb_id: tmdbId,
                    languages: lang,
                    type: 'movie',
                });
            }
            if (title) {
                attempts.push({
                    query: title,
                    languages: lang,
                    type: 'movie',
                });
            }
        }

        for (const searchParams of attempts) {
            try {
                const search = await firstValueFrom(
                    this.http.get<OpenSubsSearchResult>(`${API_BASE}/subtitles`, {
                        headers,
                        params: searchParams,
                    })
                );

                const fileId = search?.data?.[0]?.attributes?.files?.[0]?.file_id;
                if (fileId) {
                    const download = await firstValueFrom(
                        this.http.post<OpenSubsDownloadResult>(
                            `${API_BASE}/download`,
                            { file_id: fileId, sub_format: 'webvtt' },
                            {
                                headers: headers.set(
                                    'Content-Type',
                                    'application/json'
                                ),
                            }
                        )
                    );

                    if (download?.link) {
                        // Try to fetch the actual VTT text and return as a
                        // blob URL (same-origin to the renderer). Falls back
                        // to the raw link if CORS blocks the fetch.
                        try {
                            const text = await firstValueFrom(
                                this.http.get(download.link, {
                                    responseType: 'text',
                                })
                            );
                            if (text) {
                                const blob = new Blob([text], {
                                    type: 'text/vtt',
                                });
                                return URL.createObjectURL(blob);
                            }
                        } catch {
                            // CORS or network — fall through to raw link.
                        }
                        return download.link;
                    }
                }
            } catch {
                // Try the next lookup strategy.
            }
        }

        return null;
    }
}
