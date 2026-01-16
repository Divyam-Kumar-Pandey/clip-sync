import WebSocket, { WebSocketServer } from 'ws';
import { Bonjour } from 'bonjour-service';

const PORT = Number(process.env.CLIP_SYNC_PORT || process.env.PORT || 8080);
const SERVICE_NAME = 'Clipboard Hub';
const SERVICE_TYPE = 'clip-sync';

const wss = new WebSocketServer({ port: PORT });

console.log(`Clipboard Hub running on port ${PORT}...`);

const bonjourService = new Bonjour();
const advertisement = bonjourService.publish({
    name: SERVICE_NAME,
    type: SERVICE_TYPE,
    protocol: 'tcp',
    port: PORT,
    // Prefer IPv4 advertisement for better cross-device reliability on many LANs.
    disableIPv6: true,
    txt: {
        app: 'clip-sync'
    }
});

advertisement.on('up', () => {
    console.log(`mDNS advertised: ${SERVICE_NAME} (${SERVICE_TYPE}) on port ${PORT}`);
});

advertisement.on('error', (err) => {
    console.error('mDNS advertisement error:', err);
});

let advertisementStopped = false;
const stopAdvertisement = () => {
    if (advertisementStopped) {
        return;
    }
    advertisementStopped = true;
    advertisement.stop();
    bonjourService.destroy();
};

const shutdown = (signal) => {
    console.log(`Received ${signal}, stopping advertisement...`);
    stopAdvertisement();
    process.exit(0);
};

process.on('exit', stopAdvertisement);
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        // Broadcast the received message to all connected clients EXCEPT the sender
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
