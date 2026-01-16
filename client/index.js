import WebSocket from 'ws';
import clipboard from 'clipboardy';
import { Bonjour } from 'bonjour-service';

const SERVICE_TYPE = 'clip-sync';
const DISCOVERY_TIMEOUT_MS = 7000;
const DEFAULT_PORT = 8080;
const DISCOVERY_FALLBACK_URL = `ws://localhost:${DEFAULT_PORT}`;

let lastLocalContent = '';
let lastRemoteContent = '';

const pickAddress = (addresses = []) => {
    if (!addresses.length) {
        return null;
    }

    return addresses.find((addr) => addr.includes('.')) || addresses[0];
};

const discoverClipboardHub = (timeoutMs = DISCOVERY_TIMEOUT_MS) => {
    const bonjourClient = new Bonjour();

    return new Promise((resolve, reject) => {
        const browser = bonjourClient.find({ type: SERVICE_TYPE, protocol: 'tcp' });
        let settled = false;
        let cleanupTimer;

        const cleanup = () => {
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                cleanupTimer = null;
            }
            browser.stop();
            bonjourClient.destroy();
        };

        const onSuccess = (service) => {
            if (settled) {
                return;
            }

            const address = pickAddress(service.addresses);

            if (!address) {
                return;
            }

            settled = true;
            cleanup();
            resolve({
                address,
                port: service.port || DEFAULT_PORT
            });
        };

        browser.on('up', onSuccess);
        browser.on('error', (err) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(err);
        });

        cleanupTimer = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(new Error('Clipboard hub discovery timed out'));
        }, timeoutMs);
    });
};

const resolveWebSocketUrl = async () => {
    try {
        const service = await discoverClipboardHub();
        console.log(`Discovered Clipboard Hub at ${service.address}:${service.port}`);
        return `ws://${service.address}:${service.port}`;
    } catch (err) {
        console.warn('Clipboard hub discovery failed — falling back to localhost:', err.message);
        return DISCOVERY_FALLBACK_URL;
    }
};

async function checkClipboard(ws) {
    try {
        const currentContent = await clipboard.read();

        if (currentContent !== lastLocalContent) {
            if (currentContent !== lastRemoteContent) {
                console.log('🚀 Sending:', currentContent);
                ws.send(currentContent);
                lastRemoteContent = currentContent;
            }

            lastLocalContent = currentContent;
        }
    } catch (err) {
        console.error('Error while polling clipboard:', err);
    }
}

const startClipboardSync = async () => {
    const url = await resolveWebSocketUrl();
    const ws = new WebSocket(url);

    ws.on('open', async () => {
        console.log('Connected to Clipboard Hub');

        try {
            lastLocalContent = await clipboard.read();
        } catch (e) {
            console.log('Clipboard empty or unreadable');
            console.error('Initial clipboard read error:', e);
        }

        setInterval(() => checkClipboard(ws), 1000);
    });

    ws.on('message', async (data) => {
        const text = data.toString();
        lastRemoteContent = text;
        lastLocalContent = text;

        try {
            await clipboard.write(text);
            console.log('📋 Received & Synced:', text);
        } catch (err) {
            console.error('Failed to write to clipboard:', err);
        }
    });

    ws.on('close', () => {
        console.log('Disconnected from server');
    });

    ws.on('error', (err) => {
        console.error('Connection error:', err.message);
    });
};

startClipboardSync().catch((err) => {
    console.error('Failed to start clipboard sync:', err);
});