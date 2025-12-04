## Unraid Companion Tray App

Small Electron tray companion for Windows that connects to your Unraid server and surfaces CPU, memory, uptime, array usage, network throughput, plus a handy list of Docker containers and VMs.

The app supports two data sources:

- **SSH** (original mode): the tray connects directly to Unraid over SSH and runs commands.
- **WebSocket** (recommended once configured): a lightweight Node.js container on Unraid streams stats over WS.

### Requirements
- Node.js 18+ on Windows
- For **SSH** transport: SSH access to your Unraid box (password or private key)
- For **WebSocket** transport: a Docker container running the WebSocket server on Unraid

### App setup (Windows tray)
1. Install deps: `npm install`
2. Copy the sample config and fill in your details:
   ```powershell
   copy config\config.example.json config\config.json
   ```
   Key fields in `config.json`:
   - `refreshIntervalSeconds`: how often SSH polling runs (ignored in WS mode).
   - `networkInterface`: NIC used for inbound/outbound speed (`eth0`, `bond0`, `br0`, etc.).
   - `showDockerContainers`, `showVmList`, `showStoppedServices`: toggle Docker/VM panels and whether stopped services are shown.
   - `transport`: `"ssh"` or `"ws"`. This can also be changed in the in‑app **Settings** panel under “Connection type”.
   - `wsUrl`: WebSocket URL when `transport` is `"ws"` (e.g. `ws://192.168.1.207:8510`).
3. Start the tray app: `npm start`
4. Use the **Settings** button in the header to change connection type, server details, refresh interval, network interface and visibility of Docker/VM sections without editing JSON.

### WebSocket server on Unraid (Docker)
The WS mode moves all heavy lifting (CPU/RAM/array/network, Docker list, VMs) into a small container on Unraid. The Electron app then just consumes a JSON snapshot every second.

#### 1. Copy the WS server folder to Unraid
The repository includes a ready‑to‑use WS server under `ws-server/`.

On Unraid (console or SSH):

```bash
mkdir -p /boot/custom/unraid-companion-ws
cd /boot/custom/unraid-companion-ws

# Copy the contents of ws-server/ from this repo into this directory
# (e.g. via scp from your workstation or by placing them on the flash drive)
```

This folder should contain at least:

- `server.mjs`
- `package.json`
- `Dockerfile`

#### 2. Build and run the WS container
Still on Unraid, from `/boot/custom/unraid-companion-ws`:

```bash
docker build --no-cache -t unraid-companion-ws .

docker run -d \
  --name unraid-companion-ws \
  -p 8510:8510 \
  -e NET_IFACE=bond0 \
  -e UNRAID_HOST=192.168.1.207 \
  -v /sys:/sys:ro \
  -v /mnt:/mnt:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /var/run/libvirt:/var/run/libvirt \
  --privileged \
  unraid-companion-ws
```

Or use the provided `docker-compose.yml` from this repo (adjust paths/host/IP as needed) and run:

```bash
docker compose up -d
```

Notes:
- `NET_IFACE` should match the NIC you care about on Unraid (`bond0`, `br0`, `eth0`, etc.).
- `UNRAID_HOST` is used by the WS server to build Docker WebUI URLs (e.g. `http://UNRAID_HOST:PORT/...`).
- `/sys` and `/mnt` mounts allow the container to read host network and array usage.
- `/var/run/docker.sock` and `/var/run/libvirt` allow the server to list containers and VMs.

You can verify the WS feed from another machine with:

```powershell
wscat -c ws://192.168.1.207:8510
```

You should see JSON snapshots with `host`, `network`, `arrayUsage`, `containers`, and `vms` fields.

#### 4. Point the tray app at the WS server
In the tray app Settings:

- Set **Connection type** to **WebSocket**.
- Set **WebSocket URL** to e.g. `ws://192.168.1.207:8510`.
- Save settings – the tray will switch to live WS streaming (CPU/RAM/network/array, Docker/VMs) and stop SSH polling.

You can always switch back to SSH mode if needed by changing **Connection type** to **SSH**.

### How it works
- The Electron main process keeps a hidden window alive and creates a tray icon.
- Clicking the tray icon toggles a compact status popover built with vanilla HTML/JS.
- In **SSH mode**, the main process opens a short‑lived SSH session on refresh, runs a few `/proc` reads (CPU/memory/disk/network), queries Docker (`docker ps`/`docker inspect`), inspects running VMs (`virsh`), and returns normalized metrics. Results are cached for `refreshIntervalSeconds`.
- In **WebSocket mode**, a companion Docker container on Unraid (`unraid-companion-ws`) streams a JSON snapshot every second with host stats, array usage, Docker containers, and VMs; the tray just renders the latest snapshot.
- Use the in‑app **Settings** panel to update transport, host details, WS URL, refresh cadence, dashboard URL, tracked network interface, and visibility of Docker/VM panels.

### Troubleshooting
- If the tray window does not appear, check the console logs in the devtools (right-click tray icon → `Open DevTools`).
- SSH failures will surface in a red error banner in the popover plus the Electron console.
- WS failures (bad URL / server down) will also show an error screen with “Try Again” and “Edit Settings” options.
- For self-signed hosts, add the server to your `known_hosts` file on Windows (`%USERPROFILE%\.ssh\known_hosts`).
