## Cursor.io Readme – Unraid Companion

This file is a quick technical orientation for future Cursor sessions working on this project.

---

### 1. Project overview

- **Purpose**: Electron tray app for Windows that shows Unraid host health and Docker/VM status.
- **Two data paths**:
  - **SSH**: Electron connects directly to Unraid over SSH and runs shell commands.
  - **WebSocket (WS)**: A Node.js WS server runs on Unraid in a Docker container and streams JSON snapshots to the tray.

Repo structure:

- Electron app (Windows tray): root
  - `src/main.js` – Electron main process (tray window, SSH stats, IPC, config).
  - `src/preload.js` – exposes IPC surface as `window.companion`.
  - `public/index.html` – tray popup UI markup.
  - `public/renderer.js` – front-end logic (rendering, WS/SSH, settings, drag–drop).
  - `public/styles.css` – Unraid-inspired theme, layout, scrollbars.
  - `config/config.example.json` – safe defaults (no secrets), includes `transport`/`wsUrl`.
  - `config/config.json` – user’s real config (ignored by Git).
  - `package.json` – Electron app scripts, build config (electron-builder).
- WebSocket server (for Unraid): `ws-server/`
  - `ws-server/server.mjs` – WS server streaming host/array/net/containers/VMs.
  - `ws-server/package.json` – Node module definition for server.
  - `ws-server/Dockerfile` – Alpine-based image with `docker-cli` and `libvirt-client`.
- Deployment helper: `docker-compose.yml` – builds/runs WS server container on Unraid.

---

### 2. Config and transports

**Config files**

- `config/config.example.json` – template with:
  - Core fields: `host`, `port`, `username`, `authMethod`, `password`, `privateKeyPath`.
  - Behavior flags: `refreshIntervalSeconds`, `networkInterface`, `showDockerContainers`, `showVmList`, `showStoppedServices`.
  - New fields:
    - `transport`: `"ssh"` (default) or `"ws"`.
    - `wsUrl`: e.g. `ws://192.168.1.207:8510`.
    - `dockerOrder`: array of container names for custom ordering.
- `config/config.json` – user-local override; merged over defaults; **never commit** (contains secrets).

**Transport modes**

- **SSH (`transport: "ssh"`)**
  - `src/main.js`:
    - `fetchStats()` sets up an `ssh2` connection and in parallel collects:
      - **CPU**: via two `/proc/stat` reads (`collectCpuPercent`).
      - **Uptime**: `/proc/uptime`.
      - **Memory**: `MemTotal`, `MemAvailable`/`MemFree` from `/proc/meminfo`.
      - **Array**: `df -B1 /mnt/user`.
      - **Network**: `/sys/class/net/<iface>/statistics/{rx,tx}_bytes` for `config.networkInterface`.
      - **Docker containers**:
        - `docker ps` or `docker ps -a` depending on `showStoppedServices`.
        - `docker inspect` for IP resolution (handles custom networks).
        - `docker stats --no-stream` for per-container CPU/mem/net (may be heavy).
      - **VMs**: `virsh list --state-running` or `virsh list --all` depending on `showStoppedServices`.
    - Normalizes into `stats` object with:
      - `cpuPercent`, `uptimeSeconds`, `uptimeHuman`, `memory`, `arrayUsage`, `containers`, `vms`, `network`, `hostname`, `fetchedAt`.
    - Caches stats (`statsCache`) for `refreshIntervalSeconds` (min 5s) to avoid hammering.
  - Settings panel allows editing SSH details and behavior flags.

- **WebSocket (`transport: "ws"`)**
  - Renderer:
    - On `hydrateConfig()`, if `transport === 'ws' && wsUrl`, calls `connectWebSocket()` and **does not** start auto-refresh polling.
    - `refreshStats()` in WS mode:
      - No fetch; only tries to reconnect `WebSocket` if lost.
  - WS payload is normalized by `renderFromSnapshot(snapshot)` to the same shape as SSH `stats` and passed into `renderStats()`.

---

### 3. Renderer details (`public/renderer.js`)

**State**

```js
const state = {
  refreshTimer: null,
  refreshInterval: 30,
  nextRefreshAt: null,
  dashboardUrl: null,
  networkInterface: null,
  showDockers: true,
  showVms: true,
  showStoppedServices: false,
  dockerOrder: undefined,
  transport: 'ssh',
  wsUrl: null,
  ws: null
};
```

**Key flows**

- On `DOMContentLoaded`:
  - Wire refresh button (`Refresh` with countdown).
  - Wire settings controls + drag–drop.
  - `await hydrateConfig();`
  - `refreshStats();` (SSH only).

- `hydrateConfig()`:
  - Calls `window.companion.getConfig()`;
  - Sets `state.refreshInterval`, `state.networkInterface`, `showDockers`, `showVms`, `showStoppedServices`, `dockerOrder`, `transport`, `wsUrl`, `dashboardUrl`.
  - Toggles Docker/VM sections visibility by flags.
  - **SSH**:
    - `startAutoRefresh()`:
      - `setInterval` to call `refreshStats(false)` every `refreshInterval` seconds.
      - Starts countdown loop for refresh button label.
  - **WS**:
    - Calls `connectWebSocket()`.
    - Clears any SSH timers and countdown.

- `connectWebSocket()`:
  - Closes existing `state.ws` if present.
  - Creates `new WebSocket(state.wsUrl)`.
  - `onmessage`: parse JSON → `renderFromSnapshot(snapshot)`.
  - `onerror` / `onclose`:
    - Show error banner + error screen.
    - Retry connection in 5s while `state.transport === 'ws' && state.wsUrl`.

- `renderFromSnapshot(snapshot)`:
  - Extracts:
    - `host`, `networkRaw`, `containers`, `vms`, `arrayUsage`.
  - Normalizes `network` to ensure `rxRateMbps` / `txRateMbps` always present (fallback to `rxMbps` / `txMbps`).
  - Sets `stats`:
    - `cpuPercent`, `uptimeSeconds`, `uptimeHuman`, `memory: host.memory`, `arrayUsage`, `containers`, `vms`, `network`, `hostname`, `fetchedAt`.
  - Calls `renderStats(stats, false)`.

- `renderStats(stats, cached)`:
  - CPU:
    - Uses `stats.cpuPercent` if finite, sets bar width and value.
  - Memory:
    - Computes `memPercent` using `memory.usedPercent` or `usedGb/totalGb`.
    - Updates bar and `used / total GB` label.
  - Array:
    - Uses `arrayUsage.usedPercent`, `usedTb`, `totalTb`.
  - Uptime & “Updated …” labels.
  - Updates host name label and sets dashboard link if not provided.
  - Delegates to `renderNetwork(stats.network)`, `renderContainers(stats.containers)`, `renderVmList(stats.vms)`.

- `renderNetwork(network)`:
  - Renders In/Out Mbps using `formatMbps`.
  - Shows interface name label.

- `renderContainers(containers)`:
  - If `!showDockers`: hide section.
  - If empty: show “No containers detected.” placeholders.
  - Applies ordering via `applyDockerOrder()` with `state.dockerOrder`.
  - Splits into `active` (running) and `inactive`.
  - Renders separate lists; conditionally shows inactive group depending on `showStoppedServices`.
  - Sets container count label as `activeCount/total running`.

- `renderContainerList(target, items, allowLinks)`:
  - Creates `<li>` for each container:
    - `.docker-button` with icon, label, optional metrics group, status pill.
    - Click is enabled only if `allowLinks && container.url && container.running`.
    - `status-pill` position top-right, color based on running state.
    - Each `<li>` has `data-container-name` for drag–drop.

- Drag–drop reorder:
  - Active list listens for `dragstart`, `dragover`, `drop`.
  - On drop:
    - Computes `newOrder` of container names.
    - Reorders DOM immediately.
    - Saves `dockerOrder` to config via `window.companion.updateConfig({ dockerOrder })`.

- Settings:
  - `populateSettingsForm(config)` fills in fields:
    - SSH: host, port, username, auth method, private key, etc.
    - Refresh/network/dashboard.
    - Transport: SSH/WS.
    - WS URL.
    - Checkboxes for Docker/VMs/stopped services.
  - `updateSettingsVisibility()`:
    - Hides/shows SSH vs WS fields based on selected transport.
  - `handleSettingsSubmit`:
    - Builds payload from `FormData`.
    - Uses `formData.has(name)` for checkboxes to always send booleans.
    - Sends `config:update` and re-hydrates configuration.

---

### 4. WS server deployment (Unraid)

**Server code**

- `ws-server/server.mjs` is the canonical, up-to-date WS server implementation.
- Behavior:
  - Every second, sends a snapshot with:
    - `host` – CPU, RAM, uptime, hostname.
    - `network` – In/Out Mbps from `/sys/class/net/$NET_IFACE`.
    - `arrayUsage` – TB used/total from `/mnt/user`.
    - `containers` – from `docker ps -a` + `docker inspect`, kept fresh via `docker events`.
    - `vms` – from `virsh list --all` with caching.

**Docker build**

- `ws-server/Dockerfile`:

  ```dockerfile
  FROM node:20-alpine

  RUN apk add --no-cache docker-cli libvirt-client

  WORKDIR /app
  COPY package*.json ./
  RUN npm install --omit=dev
  COPY . .

  CMD ["node", "server.mjs"]
  ```

**docker-compose**

- Root `docker-compose.yml` builds the WS image from `./ws-server` and runs it with:
  - `NET_IFACE` (e.g. `bond0`).
  - `UNRAID_HOST` for building URLs.
  - Binds:
    - `/sys:/sys:ro`
    - `/mnt:/mnt:ro`
    - `/var/run/docker.sock:/var/run/docker.sock:ro`
    - `/var/run/libvirt:/var/run/libvirt`
  - `privileged: true`.

**Integration with tray**

- User sets **Connection type** to **WebSocket** in Settings.
- Sets **WebSocket URL** to `ws://<UNRAID_HOST>:8510`.
- Renderer connects and uses WS-only path; SSH polling is disabled.

---

### 5. Build and distribution notes

- To build a Windows installer:

  ```powershell
  cd "C:\Users\ijenk\UNRAID companion"
  npm install
  npm run dist
  ```

- `electron` is in `devDependencies` to satisfy `electron-builder`.
- Building may require:
  - Admin PowerShell, or
  - Windows Developer Mode (for symlink permissions).
- Output installer appears in `release/Unraid Companion Setup x.y.z.exe`.

---

### 6. Common pitfalls / reminders

- Do **not** commit `config/config.json` – keep credentials local.
- For WS to show network stats:
  - `NET_IFACE` must match a real interface, and `/sys` must be mounted into container.
- For WS array stats:
  - `/mnt` must be mounted.
- For WS Docker/VM lists:
  - `/var/run/docker.sock` and `/var/run/libvirt` must be mounted and accessible.
- When switching transports:
  - `hydrateConfig()` will rewire timers and WS connection; no need to restart the app.



