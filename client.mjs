import WebSocket from 'ws';
import clipboard from 'clipboardy';

// Replace 'localhost' with your server's IP address if running on different machines
const ws = new WebSocket('ws://192.168.1.5:8080');

let lastLocalContent = '';
let lastRemoteContent = '';

ws.on('open', async () => {
    console.log('Connected to Clipboard Hub');
    
    // Initialize with current clipboard content so we don't send old data immediately
    try {
        lastLocalContent = await clipboard.read();
    } catch (e) {
        console.log("Clipboard empty or unreadable");
        console.error("Initial clipboard read error:", e);
    }
    console.log('reached here');
    // Start watching the clipboard
    setInterval(checkClipboard, 1000);
});

ws.on('message', async (data) => {
    const text = data.toString();
    
    // 1. Update our memory so we know this came from the server
    lastRemoteContent = text;
    lastLocalContent = text; 

    // 2. Write to the actual OS clipboard
    try {
        await clipboard.write(text);
        console.log('📋 Received & Synced:', text);
    } catch (err) {
        console.error('Failed to write to clipboard:', err);
    }
});

ws.on('close', () => {
    console.log('Disconnected from server');
    // Optional: Add logic here to try reconnecting
});

ws.on('error', (err) => {
    console.error('Connection error:', err.message);
});

async function checkClipboard() {
    try {
        const currentContent = await clipboard.read();

        // If clipboard has changed...
        if (currentContent !== lastLocalContent) {
            
            // ...and it wasn't just changed BY the server (avoid infinite loop)
            if (currentContent !== lastRemoteContent) {
                console.log('🚀 Sending:', currentContent);
                ws.send(currentContent);
                lastRemoteContent = currentContent; // sync variables
            }
            
            lastLocalContent = currentContent;
        }
    } catch (err) {
        // Usually happens if clipboard is empty or contains non-text (image)
        console.error("Error while polling clipboard:", err);
    }
}