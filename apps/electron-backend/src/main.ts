import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fixPath from 'fix-path';
import { join } from 'path';
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

// Keep userData path stable in development so single-instance lock works reliably
// across repeated Nx/Electron launches.
if (!app.isPackaged) {
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
    app.setPath('userData', join(app.getPath('appData'), 'iptvmate-dev'));
}

// Allow IPTV stream servers with outdated TLS versions/cipher suites
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-ssl-errors');
app.commandLine.appendSwitch('ssl-version-min', 'tls1');

// Enable platform HEVC/H.265 hardware decoder support (Windows/macOS)
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
}

let primaryWindowId: number | null = null;

app.on('browser-window-created', (_event, window) => {
    if (primaryWindowId === null) {
        primaryWindowId = window.id;
        console.log(`[Main] Registered primary BrowserWindow id=${window.id}`);
        return;
    }

    if (window.id === primaryWindowId) {
        return;
    }

    const primaryWindow = BrowserWindow.fromId(primaryWindowId);
    if (primaryWindow && !primaryWindow.isDestroyed()) {
        if (primaryWindow.isMinimized()) {
            primaryWindow.restore();
        }
        if (!primaryWindow.isVisible()) {
            primaryWindow.show();
        }
        primaryWindow.focus();
    }

    console.warn(
        `[Main] Closing unexpected BrowserWindow id=${window.id}; primary=${primaryWindowId}`
    );
    window.close();
});

app.on('second-instance', () => {
    const mainWindow = App.mainWindow;
    if (!mainWindow) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    mainWindow.focus();
});

// Block popup/new-window creation globally for all renderer contents.
app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        if (url && /^https?:\/\//i.test(url)) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
});

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

if (hasSingleInstanceLock) {
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
}
