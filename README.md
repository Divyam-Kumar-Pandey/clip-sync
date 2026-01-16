# clip-sync

LAN clipboard sync using a small **WebSocket hub** + **client agents**. The server advertises itself via **mDNS/Bonjour** so clients can auto-discover it on the same network.

## How it works

- **Server (`server/`)**: runs a WebSocket relay (hub). Any message received from one client is broadcast to all other connected clients.
- **Client (`client/`)**: polls the local clipboard and sends changes to the hub; also writes incoming clipboard messages to the local clipboard.
- **Discovery**:
  - Preferred: **mDNS/Bonjour** (DNS-SD) service discovery for `type=clip-sync` over TCP.
  - Fallbacks (client): optional **subnet scan** → `ws://localhost:<port>`.

## Prerequisites

- Node.js (project uses ESM: `"type": "module"`)
- Devices must be on the **same LAN** (Wi‑Fi/Ethernet) for discovery/connection to work reliably.

## Install

From the repo root:

```bash
cd server && npm install
cd ../client && npm install
```

## Run

### 1) Start the hub (server)

```bash
cd server
npm start
```

By default it listens on `0.0.0.0:8080` and advertises an mDNS service named **"Clipboard Hub"**.

### 2) Start a client on each device you want to sync

```bash
cd client
npm start
```

The client will:

- discover the hub via mDNS
- connect over WebSocket
- every second, read clipboard changes and send them
- write any received text to the local clipboard

## Configuration (environment variables)

### Client (`client/index.js`)

- **`CLIP_SYNC_SERVER_URL`**: skip discovery and connect directly (example: `ws://192.168.1.10:8080`)
- **`CLIP_SYNC_SERVICE_TYPE`**: mDNS service type to browse (default: `clip-sync`)
- **`CLIP_SYNC_PORT`**: default port to assume / fallback port (default: `8080`)
- **`CLIP_SYNC_DISCOVERY_TIMEOUT_MS`**: how long to wait for mDNS discovery (default: `7000`)
- **`CLIP_SYNC_ENABLE_SCAN`**: enable subnet scan fallback (`'0'` disables; anything else enables). Default is enabled.
- **`CLIP_SYNC_SCAN_CONNECT_TIMEOUT_MS`**: per-host TCP probe timeout during scan (default: `350`)
- **`CLIP_SYNC_SCAN_MAX_HOSTS`**: maximum hosts to scan per subnet before falling back to a /24 scan (default: `512`)

### Server (`server/index.js`)

- **`CLIP_SYNC_PORT`** or **`PORT`**: port to listen on (default: `8080`)
- **`CLIP_SYNC_HOST`**: host/interface to bind to (default: `0.0.0.0`)

## Troubleshooting

- **Discovery works on one network but not another**
  - Some enterprise or guest Wi‑Fi networks block multicast (mDNS). Use `CLIP_SYNC_SERVER_URL` to connect directly by IP.
- **Subnet scan is slow**
  - Disable it with `CLIP_SYNC_ENABLE_SCAN=0` and use `CLIP_SYNC_SERVER_URL` or fix mDNS on the network.
- **Clients connect but clipboard doesn’t update**
  - `clipboardy` depends on OS clipboard tooling. Ensure your OS supports clipboard access from Node and the process has permission.

## Security notes

- This is designed for **trusted local networks**.
- Clipboard contents are sent as plain text over WebSockets on your LAN (no auth/encryption in this code).
- Do not expose the hub directly to the public internet without adding authentication and TLS.

## Repo layout

```text
clip-sync/
  server/   # WebSocket hub + mDNS advertisement
  client/   # Clipboard agent (poll + send + receive + write)
```


