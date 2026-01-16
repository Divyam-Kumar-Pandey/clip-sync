import WebSocket from 'ws';

const wss = new WebSocket.Server({ port: 8080 });

console.log("Clipboard Hub running on port 8080...");

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
