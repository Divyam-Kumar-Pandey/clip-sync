import WebSocket from 'ws';
import clipboard from 'clipboardy';
import { Bonjour } from 'bonjour-service';
import os from 'os';
import net from 'net';

const SERVICE_TYPE = process.env.CLIP_SYNC_SERVICE_TYPE || 'clip-sync';
const DISCOVERY_TIMEOUT_MS = Number(process.env.CLIP_SYNC_DISCOVERY_TIMEOUT_MS || 7000);
const DEFAULT_PORT = Number(process.env.CLIP_SYNC_PORT || 8080);
const DISCOVERY_FALLBACK_URL = `ws://localhost:${DEFAULT_PORT}`;
const ENV_SERVER_URL = process.env.CLIP_SYNC_SERVER_URL;
const ENABLE_SUBNET_SCAN = process.env.CLIP_SYNC_ENABLE_SCAN !== '0';
const SCAN_CONNECT_TIMEOUT_MS = Number(process.env.CLIP_SYNC_SCAN_CONNECT_TIMEOUT_MS || 350);
const SCAN_MAX_HOSTS = Number(process.env.CLIP_SYNC_SCAN_MAX_HOSTS || 512);

let lastLocalContent = '';
let lastRemoteContent = '';

const isProbablyIPv4 = (addr) => typeof addr === 'string' && addr.includes('.');
const isProbablyIPv6 = (addr) => typeof addr === 'string' && addr.includes(':');
const isLinkLocalIPv6 = (addr) => typeof addr === 'string' && addr.toLowerCase().startsWith('fe80:');

const pickBestAddress = (service) => {
    const addresses = Array.isArray(service?.addresses) ? service.addresses : [];
    const refererAddress = service?.referer?.address;

    const candidates = [
        ...addresses,
        ...(refererAddress ? [refererAddress] : [])
    ].filter(Boolean);

    if (!candidates.length) {
        return null;
    }

    // Prefer routable IPv4 first, then non-link-local IPv6, then anything.
    const ipv4 = candidates.find(isProbablyIPv4);
    if (ipv4) {
        return ipv4;
    }

    const ipv6 = candidates.find((addr) => isProbablyIPv6(addr) && !isLinkLocalIPv6(addr));
    if (ipv6) {
        return ipv6;
    }

    return candidates[0];
};

const toWsUrl = (address, port) => {
    if (isProbablyIPv6(address)) {
        return `ws://[${address}]:${port}`;
    }
    return `ws://${address}:${port}`;
};

const ipToInt = (ip) => ip.split('.').reduce((acc, octet) => ((acc << 8) | (Number(octet) & 255)) >>> 0, 0);
const intToIp = (num) => [num >>> 24, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');

const enumerateSubnetHosts = (address, netmask) => {
    const addrInt = ipToInt(address);
    const maskInt = ipToInt(netmask);
    const network = addrInt & maskInt;
    const broadcast = (network | (~maskInt >>> 0)) >>> 0;
    const hostCount = Math.max(0, broadcast - network - 1);

    if (hostCount > SCAN_MAX_HOSTS) {
        return [];
    }

    const hosts = [];
    for (let i = network + 1; i < broadcast; i++) {
        hosts.push(intToIp(i >>> 0));
    }
    return hosts;
};

const getLocalIPv4Interfaces = () => {
    const ifaces = os.networkInterfaces();
    const results = [];
    for (const infos of Object.values(ifaces)) {
        for (const info of infos || []) {
            if (info.family === 'IPv4' && !info.internal && info.address && info.netmask) {
                results.push({ address: info.address, netmask: info.netmask });
            }
        }
    }
    return results;
};

const probeTcpPortOpen = (host, port, timeoutMs) => {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let settled = false;

        const done = (value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
};

const scanLocalNetworkForHub = async () => {
    const candidates = new Set();
    const localIfaces = getLocalIPv4Interfaces();

    for (const iface of localIfaces) {
        for (const ip of enumerateSubnetHosts(iface.address, iface.netmask)) {
            if (ip !== iface.address) {
                candidates.add(ip);
            }
        }
    }

    const ips = [...candidates];
    if (!ips.length) {
        return null;
    }

    console.log(`Subnet scan enabled: probing up to ${ips.length} hosts on port ${DEFAULT_PORT}...`);

    const concurrency = 80;
    let index = 0;
    let found = null;

    const worker = async () => {
        while (index < ips.length && !found) {
            const ip = ips[index++];
            const open = await probeTcpPortOpen(ip, DEFAULT_PORT, SCAN_CONNECT_TIMEOUT_MS);
            if (open) {
                found = ip;
                return;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
    return found;
};

const discoverClipboardHub = (timeoutMs = DISCOVERY_TIMEOUT_MS) => {
    const bonjourClient = new Bonjour();

    return new Promise((resolve, reject) => {
        const browser = bonjourClient.find({ type: SERVICE_TYPE, protocol: 'tcp' });
        let settled = false;
        let cleanupTimer;
        let updateTimer;

        const cleanup = () => {
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                cleanupTimer = null;
            }
            if (updateTimer) {
                clearInterval(updateTimer);
                updateTimer = null;
            }
            browser.stop();
            bonjourClient.destroy();
        };

        const onSuccess = (service) => {
            if (settled) {
                return;
            }

            const address = pickBestAddress(service);

            if (!address) {
                console.log('Discovered service without usable address:', {
                    name: service?.name,
                    type: service?.type,
                    protocol: service?.protocol,
                    host: service?.host,
                    port: service?.port,
                    addresses: service?.addresses,
                    referer: service?.referer
                });
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

        // Re-query periodically during the discovery window to improve reliability on some networks.
        updateTimer = setInterval(() => browser.update(), 1000);

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
    if (ENV_SERVER_URL) {
        console.log(`Using CLIP_SYNC_SERVER_URL override: ${ENV_SERVER_URL}`);
        return ENV_SERVER_URL;
    }

    try {
        const service = await discoverClipboardHub();
        console.log(`Discovered Clipboard Hub at ${service.address}:${service.port}`);
        return toWsUrl(service.address, service.port);
    } catch (err) {
        console.warn('Clipboard hub discovery failed:', err.message);

        if (ENABLE_SUBNET_SCAN) {
            const ip = await scanLocalNetworkForHub();
            if (ip) {
                console.log(`Subnet scan found a candidate at ${ip}:${DEFAULT_PORT}`);
                return toWsUrl(ip, DEFAULT_PORT);
            }
        }

        console.warn('Falling back to localhost.');
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