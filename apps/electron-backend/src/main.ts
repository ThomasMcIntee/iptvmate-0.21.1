import { app, BrowserWindow, ipcMain } from 'electron';
import fixPath from 'fix-path';
import App from './app/app';
import { initDatabase } from './app/database/connection';
import {
    getStreamProxyPort,
    startStreamProxy,
} from './app/services/stream-proxy.service';
import DatabaseEvents from './app/events/database.events';
import {
    resetStaleDownloads,
    setMainWindow as setDownloadsMainWindow,
} from './app/events/database/downloads.events';
import ElectronEvents from './app/events/electron.events';
import EpgEvents from './app/events/epg.events';
import PlayerEvents from './app/events/player.events';
import PlaylistEvents from './app/events/playlist.events';
import RemoteControlEvents from './app/events/remote-control.events';
import SettingsEvents from './app/events/settings.events';
import SharedEvents from './app/events/shared.events';
import SquirrelEvents from './app/events/squirrel.events';
import StalkerEvents from './app/events/stalker.events';
import XtreamEvents from './app/events/xtream.events';

app.setName('iptvmate');

// Allow IPTV stream servers with outdated TLS versions/cipher suites
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-ssl-errors');
app.commandLine.appendSwitch('ssl-version-min', 'tls1');

// Enable platform HEVC/H.265 hardware decoder support (Windows/macOS)
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

let streamProxyStartPromise: Promise<number> | null = null;

async function ensureStreamProxyStarted(): Promise<number> {
    if (streamProxyStartPromise) {
        return streamProxyStartPromise;
    }

    streamProxyStartPromise = startStreamProxy();
    return streamProxyStartPromise;
}

// Register early to avoid renderer/main startup race.
ipcMain.handle('GET_STREAM_PROXY_PORT', async () => {
    if (!getStreamProxyPort()) {
        await ensureStreamProxyStarted();
    }

    return getStreamProxyPort();
});

export default class Main {
    static initialize() {
        if (SquirrelEvents.handleEvents()) {
            // squirrel event handled (except first run event) and app will exit in 1000ms, so don't do anything else
            app.quit();
        }
    }

    static bootstrapApp() {
        App.main(app, BrowserWindow);
    }

    static async bootstrapAppEvents() {
        // Start stream proxy before other init so the port is available immediately
        await ensureStreamProxyStarted();

        // Initialize database before other events
        await initDatabase();

        ElectronEvents.bootstrapElectronEvents();
        PlaylistEvents.bootstrapPlaylistEvents();
        SharedEvents.bootstrapSharedEvents();
        PlayerEvents.bootstrapPlayerEvents();
        SettingsEvents.bootstrapSettingsEvents();
        StalkerEvents.bootstrapStalkerEvents();
        XtreamEvents.bootstrapXtreamEvents();
        DatabaseEvents.bootstrapDatabaseEvents();
        EpgEvents.bootstrapEpgEvents();
        RemoteControlEvents.bootstrapRemoteControlEvents();

        // Set main window for downloads and reset stale downloads
        if (App.mainWindow) {
            setDownloadsMainWindow(App.mainWindow);
        }
        await resetStaleDownloads();

        // initialize auto updater service
        if (!App.isDevelopmentMode()) {
            // UpdateEvents.initAutoUpdateService();
        }
    }
}

fixPath();

// handle setup events as quickly as possible
Main.initialize();

// bootstrap app
Main.bootstrapApp();

// Bootstrap app events after Electron app is ready
app.whenReady().then(async () => {
    try {
        await Main.bootstrapAppEvents();
    } catch (error) {
        console.error('Failed to bootstrap app events:', error);
    }
});
