import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

const children = [];
const isWindows = process.platform === 'win32';

const configArg = process.argv.find((arg) => arg.startsWith('--config='));
const webConfig = configArg ? configArg.split('=')[1] : 'pwa';

function run(command, args, name) {
    const child = spawn(command, args, {
        stdio: 'inherit',
        shell: false,
    });

    children.push({ child, name });

    child.on('exit', (code, signal) => {
        if (signal) {
            console.log(`[${name}] exited with signal ${signal}`);
            return;
        }
        console.log(`[${name}] exited with code ${code ?? 0}`);
        if (code && code !== 0) {
            shutdown(code);
        }
    });

    child.on('error', (error) => {
        console.error(`[${name}] failed to start: ${error.message}`);
        shutdown(1);
    });

    return child;
}

function runWebServer() {
    if (isWindows) {
        const commandShell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
        return run(
            commandShell,
            ['/d', '/s', '/c', `pnpm nx serve web --configuration=${webConfig} --no-tui`],
            'web'
        );
    }

    return run(
        'pnpm',
        ['nx', 'serve', 'web', `--configuration=${webConfig}`, '--no-tui'],
        'web'
    );
}

async function isPortInUse(port) {
    const hosts = ['localhost', '127.0.0.1', '::1'];

    for (const host of hosts) {
        const inUse = await new Promise((resolve) => {
            const socket = new Socket();

            const finish = (busy) => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(busy);
            };

            socket.setTimeout(600);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
            socket.connect(port, host);
        });

        if (inUse) {
            return true;
        }
    }

    return false;
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const { child } of children) {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    }

    setTimeout(() => {
        for (const { child } of children) {
            if (!child.killed) {
                child.kill('SIGKILL');
            }
        }
        process.exit(exitCode);
    }, 1200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[pwa-dev-runner] Starting proxy on :3000 and web app on :4200 (config: ${webConfig})`);

const proxyBusy = await isPortInUse(3000);
if (proxyBusy) {
    console.log('[pwa-dev-runner] Port 3000 is already in use; reusing existing proxy');
} else {
    run(process.execPath, ['proxy-server.js', '3000'], 'proxy');
}

const webBusy = await isPortInUse(4200);
if (webBusy) {
    console.log('[pwa-dev-runner] Port 4200 is already in use; reusing existing web server');
} else {
    runWebServer();
}

if (children.length === 0) {
    console.log('[pwa-dev-runner] Nothing to start; both services are already running');
    process.exit(0);
}
