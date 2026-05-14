import { app, BrowserWindow, Menu, screen, session, shell } from 'electron';
import { join } from 'path';
import { rendererAppName, rendererAppPort } from './constants';
import { store, WINDOW_BOUNDS } from './services/store.service';

export default class App {
    // Keep a global reference of the window object, if you don't, the window will
    // be closed automatically when the JavaScript object is garbage collected.
    static mainWindow: Electron.BrowserWindow | null;
    static application: Electron.App;
    static BrowserWindow: typeof BrowserWindow;

    public static isDevelopmentMode() {
        // First check ELECTRON_IS_DEV environment variable (used by E2E tests)
        // This allows E2E tests to run in production mode without packaging
        if ('ELECTRON_IS_DEV' in process.env) {
            return parseInt(process.env.ELECTRON_IS_DEV || '0', 10) === 1;
        }
        // Fall back to Electron's built-in app.isPackaged
        // This is the most reliable way to detect if the app is packaged
        return !app.isPackaged;
    }

    private static onWindowAllClosed() {
        if (process.platform !== 'darwin') {
            App.application.quit();
        }
    }

    private static onClose() {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        App.mainWindow = null;
    }

    private static onRedirect(
        event: { preventDefault: () => void },
        url: string
    ) {
        if (App.mainWindow && url !== App.mainWindow.webContents.getURL()) {
            // this is a normal external redirect, open it in a new browser window
            event.preventDefault();
            shell.openExternal(url);
        }
    }

    private static onReady() {
        // This method will be called when Electron has finished
        // initialization and is ready to create browser windows.
        // Some APIs can only be used after this event occurs.

        if (App.mainWindow && !App.mainWindow.isDestroyed()) {
            if (App.mainWindow.isMinimized()) {
                App.mainWindow.restore();
            }
            App.mainWindow.focus();
            return;
        }

        // Allow IPTV stream servers with non-standard TLS configurations
        // (e.g. outdated cipher suites) by bypassing certificate verification.
        session.defaultSession.setCertificateVerifyProc((_request, callback) => {
            callback(0); // 0 = success, bypass certificate errors
        });

        if (rendererAppName) {
            App.initMainWindow();
            App.loadMainWindow();
        }
    }

    private static onActivate() {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (App.mainWindow === null) {
            App.onReady();
        }
    }

    private static initMainWindow() {
        if (App.mainWindow && !App.mainWindow.isDestroyed()) {
            return;
        }

        const workAreaSize = screen.getPrimaryDisplay().workAreaSize;
        const width = Math.min(1280, workAreaSize.width || 1280);
        const height = Math.min(720, workAreaSize.height || 720);

        const savedWindowBounds = store.get(WINDOW_BOUNDS);

        // Create the browser window.
        App.mainWindow = new BrowserWindow({
            title: 'iptvmate',
            show: false,
            webPreferences: {
                contextIsolation: true,
                backgroundThrottling: false,
                preload: join(__dirname, 'main.preload.js'),
            },
            minHeight: 600,
            minWidth: 900,
            ...savedWindowBounds,
            width,
            height,
            ...(process.platform === 'darwin'
                ? {
                      titleBarStyle: 'hidden',
                      titleBarOverlay: true,
                  }
                : {}),
        });
        const mainWindow = App.mainWindow;

        if (!mainWindow) {
            return;
        }

        mainWindow.setMenu(null);
        if (!savedWindowBounds) {
            mainWindow.center();
        }

        // if main window is ready to show, close the splash window and show the main window
        mainWindow.once('ready-to-show', () => {
            // In development, delay showing until content loads
            if (App.isDevelopmentMode()) {
                // Show after a delay to allow retry to succeed
                setTimeout(() => {
                    mainWindow.show();
                }, 4000);
            } else {
                mainWindow.show();
            }
        });

        // handle all external redirects in a new browser window
        // App.mainWindow.webContents.on('will-navigate', App.onRedirect);
        // App.mainWindow.webContents.on('new-window', (event, url, frameName, disposition, options) => {
        //     App.onRedirect(event, url);
        // });

        // Block renderer popups/new windows and route external URLs to system browser.
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (url && /^https?:\/\//i.test(url)) {
                void shell.openExternal(url);
            }
            return { action: 'deny' };
        });

        // Emitted when the window is closed.
        mainWindow.on('closed', () => {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element.
            App.mainWindow = null;
        });

        mainWindow.on('close', () => {
            if (App.mainWindow) {
                store.set(WINDOW_BOUNDS, App.mainWindow.getNormalBounds());
            }
        });

        // Enable context menu for input fields only
        mainWindow.webContents.on('context-menu', (_event, params) => {
            const { isEditable, editFlags } = params;

            // Check if this is an editable field (input, textarea, contenteditable)
            // editFlags.canPaste is a good indicator of an input field
            if (isEditable && editFlags.canPaste) {
                const menu = Menu.buildFromTemplate([
                    {
                        label: 'Cut',
                        role: 'cut',
                        enabled: editFlags.canCut,
                    },
                    {
                        label: 'Copy',
                        role: 'copy',
                        enabled: editFlags.canCopy,
                    },
                    {
                        label: 'Paste',
                        role: 'paste',
                        enabled: editFlags.canPaste,
                    },
                    {
                        type: 'separator',
                    },
                    {
                        label: 'Select All',
                        role: 'selectAll',
                        enabled: editFlags.canSelectAll,
                    },
                ]);

                menu.popup();
            }
        });
    }

    private static loadMainWindow() {
        const mainWindow = App.mainWindow;

        if (!mainWindow) {
            return;
        }

        // load the index.html of the app.
        if (App.isDevelopmentMode()) {
            const url = `http://localhost:${rendererAppPort}`;
            const tryLoad = () => {
                mainWindow.loadURL(url).catch(() => {
                    // Angular dev server not ready yet – retry after 1s
                    setTimeout(tryLoad, 1000);
                });
            };
            // Wait 3s for dev server to start before first attempt
            setTimeout(tryLoad, 3000);
            if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
                mainWindow.webContents.openDevTools({ mode: 'bottom' });
            }
        } else {
            mainWindow.loadFile(join(__dirname, '..', rendererAppName, 'index.html'));
        }
    }

    static main(app: Electron.App, browserWindow: typeof BrowserWindow) {
        // we pass the Electron.App object and the
        // Electron.BrowserWindow into this function
        // so this class has no dependencies. This
        // makes the code easier to write tests for

        App.BrowserWindow = browserWindow;
        App.application = app;

        App.application.on('window-all-closed', App.onWindowAllClosed); // Quit when all windows are closed.
        App.application.on('ready', App.onReady); // App is ready to load data
        App.application.on('activate', App.onActivate); // App is activated
        App.application.on('browser-window-created', (_event, window) => {
            if (!App.mainWindow || window === App.mainWindow) {
                return;
            }

            if (App.mainWindow.isMinimized()) {
                App.mainWindow.restore();
            }
            App.mainWindow.focus();

            // Defensive guard: this app is intended to run with a single main window.
            window.close();
        });
        App.application.on('before-quit', () => {
            if (App.mainWindow)
                store.set(WINDOW_BOUNDS, App.mainWindow.getNormalBounds());
        });
    }
}
