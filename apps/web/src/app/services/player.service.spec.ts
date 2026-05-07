import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { DataService } from 'services';
import {
    OPEN_MPV_PLAYER,
    VideoPlayer,
} from 'shared-interfaces';
import { PlayerDialogComponent } from '../xtream-tauri/player-dialog/player-dialog.component';
import { PlayerService } from './player.service';
import { SettingsStore } from './settings-store.service';

describe('PlayerService', () => {
    let service: PlayerService;
    let dialog: { open: jest.Mock };
    let dataService: { sendIpcEvent: jest.Mock };
    let settingsStore: { player: jest.Mock };

    beforeEach(() => {
        dialog = { open: jest.fn() };
        dataService = { sendIpcEvent: jest.fn() };
        settingsStore = { player: jest.fn(() => VideoPlayer.VideoJs) };

        TestBed.configureTestingModule({
            providers: [
                PlayerService,
                { provide: MatDialog, useValue: dialog },
                { provide: DataService, useValue: dataService },
                { provide: SettingsStore, useValue: settingsStore },
            ],
        });

        service = TestBed.inject(PlayerService);
        delete (window as Window & { electron?: unknown }).electron;
    });

    afterEach(() => {
        jest.clearAllMocks();
        delete (window as Window & { electron?: unknown }).electron;
    });

    it('proxies browser dialog playback urls with passthrough headers', () => {
        const rawUrl = 'http://provider.example/series/user/pass/42.mp4';

        service.openPlayer(
            rawUrl,
            'Episode 42',
            undefined,
            true,
            false,
            'TestAgent/1.0',
            'https://ref.example/app',
            'https://origin.example'
        );

        expect(dialog.open).toHaveBeenCalledWith(
            PlayerDialogComponent,
            expect.any(Object)
        );

        const config = dialog.open.mock.calls[0][1];
        const playableUrl = new URL(config.data.streamUrl);

        expect(playableUrl.origin).toBe('http://localhost:3000');
        expect(playableUrl.pathname).toBe('/stream');
        expect(playableUrl.searchParams.get('url')).toBe(rawUrl);
        expect(playableUrl.searchParams.get('ua')).toBe('TestAgent/1.0');
        expect(playableUrl.searchParams.get('ref')).toBe(
            'https://ref.example/app'
        );
        expect(playableUrl.searchParams.get('org')).toBe(
            'https://origin.example'
        );
    });

    it('does not double-proxy urls that already target the stream endpoint', () => {
        const proxiedUrl =
            'http://localhost:3000/stream?url=http%3A%2F%2Fprovider.example%2Fmovie%2F1.mp4';

        service.openPlayer(proxiedUrl, 'Movie');

        const config = dialog.open.mock.calls[0][1];
        expect(config.data.streamUrl).toBe(proxiedUrl);
    });

    it('keeps the raw url for external players', () => {
        settingsStore.player.mockReturnValue(VideoPlayer.MPV);
        const rawUrl = 'http://provider.example/movie/user/pass/99.mp4';

        service.openPlayer(rawUrl, 'Movie 99');

        expect(dialog.open).not.toHaveBeenCalled();
        expect(dataService.sendIpcEvent).toHaveBeenCalledWith(
            OPEN_MPV_PLAYER,
            expect.objectContaining({ url: rawUrl })
        );
    });
});