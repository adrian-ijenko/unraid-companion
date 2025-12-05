import { WebSocketServer } from 'ws';
import fs from 'fs';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT = process.env.PORT || 8510;
const INTERFACE = process.env.NET_IFACE || 'bond0'; // e.g. bond0, br0, eth0
const UNRAID_HOST = process.env.UNRAID_HOST || null; // e.g. 192.168.1.207

// VM cache (we still poll virsh, but slowly)
const VM_CACHE_MS = 60_000;

let lastNet = null;

// Containers cache: initialised once via docker ps -a + inspect, then updated via docker events
let containersCache = {
  initialised: false,
  list: [],
  byId: new Map()
};

let vmsCache = { ts: 0, value: [] };

const wss = new WebSocketServer({ port: PORT });
console.log(`Unraid companion WS listening on ws://0.0.0.0:${PORT}`);
console.log(`Using interface: ${INTERFACE}`);
if (UNRAID_HOST) {
  console.log(`Using UNRAID_HOST for URL building: ${UNRAID_HOST}`);
} else {
  console.log('UNRAID_HOST not set; will fall back to container IP / localhost for URLs.');
}

// Start docker events listener immediately
startDockerEventsListener();

// Periodic snapshots to clients
wss.on('connection', (ws) => {
  console.log('Client connected');

  const interval = setInterval(async () => {
    try {
      const payload = await collectSnapshot();
      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('collectSnapshot failed:', err.message);
    }
  }, 1000); // 1s tick

  ws.on('close', () => {
    clearInterval(interval);
    console.log('Client disconnected');
  });
});

async function collectSnapshot() {
  const [host, network, arrayUsage, containers, vms] = await Promise.all([
    collectHostStats(),
    collectNetworkStats(),
    collectArrayUsage(),
    getContainersSnapshot(),
    getVmsSnapshot()
  ]);

  return {
    ts: new Date().toISOString(),
    host,
    network,
    arrayUsage,
    containers,
    vms
  };
}

/* -------- Host stats (CPU, RAM, uptime) -------- */

async function collectHostStats() {
  const uptimeSeconds = Number.parseInt(
    fs.readFileSync('/proc/uptime', 'utf-8').split('.')[0],
    10
  );

  const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
    .trim()
    .split('\n')
    .reduce((acc, line) => {
      const [k, v] = line.split(':');
      acc[k.trim()] = Number.parseInt(v, 10);
      return acc;
    }, {});

  const totalKb = meminfo.MemTotal || 0;
  const freeKb = meminfo.MemAvailable ?? meminfo.MemFree ?? 0;
  const usedKb = Math.max(totalKb - freeKb, 0);
  const usedPercent = totalKb ? (usedKb / totalKb) * 100 : 0;

  const cpuPercent = await collectCpuPercent();

  return {
    uptimeSeconds,
    memory: {
      totalGb: round(totalKb / 1024 / 1024),
      usedGb: round(usedKb / 1024 / 1024),
      usedPercent: clamp(usedPercent, 0, 100)
    },
    hostname: os.hostname(),
    cpuPercent
  };
}

async function collectCpuPercent() {
  const first = parseCpuLine(fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0]);
  await new Promise((r) => setTimeout(r, 400));
  const second = parseCpuLine(fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0]);
  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  const usage = totalDelta === 0 ? 0 : (1 - idleDelta / totalDelta) * 100;
  return clamp(usage, 0, 100);
}

function parseCpuLine(line) {
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((num) => Number(num));
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  return { idle, total };
}

/* -------- Overall network (interface Mbps) -------- */

async function collectNetworkStats() {
  const rxPath = `/sys/class/net/${INTERFACE}/statistics/rx_bytes`;
  const txPath = `/sys/class/net/${INTERFACE}/statistics/tx_bytes`;
  if (!fs.existsSync(rxPath) || !fs.existsSync(txPath)) {
    return null;
  }

  const rxBytes = Number.parseInt(fs.readFileSync(rxPath, 'utf-8'), 10);
  const txBytes = Number.parseInt(fs.readFileSync(txPath, 'utf-8'), 10);
  const now = Date.now();

  let rxMbps = null;
  let txMbps = null;

  if (lastNet && lastNet.iface === INTERFACE) {
    const seconds = (now - lastNet.ts) / 1000;
    if (seconds > 0) {
      rxMbps = ((rxBytes - lastNet.rxBytes) * 8) / seconds / 1e6;
      txMbps = ((txBytes - lastNet.txBytes) * 8) / seconds / 1e6;
    }
  }

  lastNet = { iface: INTERFACE, rxBytes, txBytes, ts: now };

  return {
    interface: INTERFACE,
    rxMbps,
    txMbps,
    rxRateMbps: rxMbps,
    txRateMbps: txMbps
  };
}

/* -------- Array / HDD usage (/mnt/user) -------- */

async function collectArrayUsage() {
  try {
    const { stdout } = await execAsync('df -B1 /mnt/user | tail -n 1');
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 5) {
      return {
        totalTb: 0,
        usedTb: 0,
        usedPercent: 0
      };
    }

    const totalBytes = Number(parts[1]) || 0;
    const usedBytes = Number(parts[2]) || 0;
    const fallbackPercent = totalBytes ? (usedBytes / totalBytes) * 100 : 0;
    const usedPercent =
      parts[4] && parts[4].endsWith('%')
        ? Number(parts[4].slice(0, -1))
        : fallbackPercent;

    return {
      totalTb: round(totalBytes ? totalBytes / 1024 / 1024 / 1024 / 1024 : 0),
      usedTb: round(usedBytes ? usedBytes / 1024 / 1024 / 1024 / 1024 : 0),
      usedPercent: clamp(usedPercent, 0, 100)
    };
  } catch (err) {
    console.error('collectArrayUsage failed:', err.message);
    return null;
  }
}

/* -------- Containers (docker ps -a + inspect, updated by docker events) -------- */

async function getContainersSnapshot() {
  // Ensure we have at least one full snapshot
  if (!containersCache.initialised) {
    await fullContainersRefresh();
  }
  return containersCache.list;
}

async function fullContainersRefresh() {
  try {
    const { stdout } = await execAsync(
      "docker ps -a --format '{{json .}}' --no-trunc || true"
    );
    if (!stdout || !stdout.trim()) {
      containersCache = { initialised: true, list: [], byId: new Map() };
      return;
    }

    const psLines = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const psEntries = [];
    const ids = [];

    for (const line of psLines) {
      try {
        const entry = JSON.parse(line);
        psEntries.push(entry);
        if (entry.ID) ids.push(entry.ID);
      } catch {
        // ignore bad line
      }
    }

    let inspectMap = new Map();
    if (ids.length) {
      inspectMap = await inspectContainers(ids);
    }

    const list = [];
    const byId = new Map();

    for (const entry of psEntries) {
      const details = inspectMap.get(entry.ID) || null;
      const obj = buildContainerFromPsAndInspect(entry, details);
      if (!obj) continue;
      list.push(obj);
      if (obj.id) {
        byId.set(obj.id, obj);
      }
    }

    containersCache = { initialised: true, list, byId };
    console.log(`Loaded ${list.length} containers from docker ps -a + inspect`);
  } catch (err) {
    console.error('fullContainersRefresh failed:', err.message);
    containersCache.initialised = true;
  }
}

async function refreshSingleContainer(id) {
  if (!id) return;
  try {
    const { stdout } = await execAsync(
      `docker ps -a --no-trunc --filter id=${id} --format '{{json .}}' || true`
    );
    if (!stdout || !stdout.trim()) {
      // Container gone; remove from cache
      removeContainerFromCache(id);
      return;
    }
    const line = stdout.trim().split('\n')[0].trim();
    const entry = JSON.parse(line);

    let details = null;
    try {
      const inspectOut = await execAsync(`docker inspect ${entry.ID}`);
      const parsed = JSON.parse(inspectOut.stdout);
      if (Array.isArray(parsed) && parsed[0]) {
        details = parsed[0];
      }
    } catch (err) {
      console.warn('docker inspect failed for', id, err.message);
    }

    const obj = buildContainerFromPsAndInspect(entry, details);
    if (!obj) return;
    upsertContainerInCache(obj);
  } catch (err) {
    console.error('refreshSingleContainer failed for', id, err.message);
  }
}

function upsertContainerInCache(container) {
  const byId = containersCache.byId;
  const list = containersCache.list.slice();

  const existingIndex = list.findIndex((c) => c.id === container.id);
  if (existingIndex >= 0) {
    list[existingIndex] = container;
  } else {
    list.push(container);
  }

  if (container.id) {
    byId.set(container.id, container);
  }

  containersCache = {
    ...containersCache,
    list,
    byId
  };
}

function removeContainerFromCache(id) {
  if (!id) return;
  const byId = containersCache.byId;
  const list = containersCache.list.filter((c) => c.id !== id);
  byId.delete(id);
  containersCache = {
    ...containersCache,
    list,
    byId
  };
}

async function inspectContainers(ids = []) {
  if (!ids.length) return new Map();
  const uniqueIds = Array.from(new Set(ids));
  try {
    const { stdout } = await execAsync(`docker inspect ${uniqueIds.join(' ')} || true`);
    if (!stdout || !stdout.trim()) return new Map();
    const parsed = JSON.parse(stdout);
    const map = new Map();
    parsed.forEach((item) => {
      if (!item?.Id) return;
      map.set(item.Id, item);
      const shortId = item.Id.slice(0, 12);
      map.set(shortId, item);
    });
    return map;
  } catch (err) {
    console.warn('inspectContainers failed:', err.message);
    return new Map();
  }
}

function buildContainerFromPsAndInspect(entry, details) {
  if (!entry || !entry.ID) return null;

  const status = String(entry.Status || '').toLowerCase();
  const running = status.startsWith('up');

  const ports = parseDockerPorts(entry.Ports || '');
  const labels = parseDockerLabels(entry.Labels || '');
  const containerIp = resolveContainerIp(details);

  const templateContext = { containerIp };
  const explicitUrl = applyDockerTemplate(labels['net.unraid.docker.webui'], ports, templateContext);
  const explicitIcon = applyDockerTemplate(labels['net.unraid.docker.icon'], ports, templateContext);

  const url = normalizeUrl(explicitUrl) || deriveDockerUrl(ports, containerIp);
  const icon = normalizeUrl(explicitIcon);

  return {
    id: entry.ID,
    name: entry.Names,
    image: entry.Image,
    status: entry.Status,
    running,
    ports,
    containerIp,
    url,
    icon,
    metrics: null // no per-container stats in WS path
  };
}

/* -------- docker events listener (update cache on change) -------- */

function startDockerEventsListener() {
  try {
    const child = spawn('docker', ['events', '--format', '{{json .}}']);

    console.log('docker events listener started');

    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        handleDockerEventLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.warn('docker events stderr:', msg);
      }
    });

    child.on('close', (code) => {
      console.warn(`docker events exited with code ${code}. Restarting in 5s…`);
      setTimeout(startDockerEventsListener, 5000);
    });

    child.on('error', (err) => {
      console.error('Failed to start docker events listener:', err.message);
      setTimeout(startDockerEventsListener, 5000);
    });
  } catch (err) {
    console.error('startDockerEventsListener error:', err.message);
    setTimeout(startDockerEventsListener, 5000);
  }
}

function handleDockerEventLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }

  if (!evt || (evt.Type && evt.Type !== 'container')) {
    return;
  }

  const id = evt.id || evt.ID || (evt.Actor && evt.Actor.ID);
  const actionRaw = evt.status || evt.Action || '';
  const action = String(actionRaw).toLowerCase();

  if (!id || !action) return;

  if (
    action.includes('create') ||
    action.includes('start') ||
    action.includes('restart') ||
    action.includes('rename') ||
    action.includes('unpause') ||
    action.includes('pause') ||
    action.includes('die') ||
    action.includes('stop')
  ) {
    refreshSingleContainer(id);
    return;
  }

  if (action.includes('destroy') || action.includes('remove')) {
    removeContainerFromCache(id);
  }
}

/* -------- VMs (all) via virsh (slow poll) -------- */

async function getVmsSnapshot() {
  const now = Date.now();
  if (now - vmsCache.ts < VM_CACHE_MS) {
    return vmsCache.value;
  }

  try {
    const vms = await collectVmStats();
    vmsCache = { ts: now, value: vms };
    return vms;
  } catch (err) {
    console.error('collectVmStats failed:', err.message);
    return vmsCache.value || [];
  }
}

async function collectVmStats() {
  const { stdout } = await execAsync('virsh list --all || true');
  if (!stdout || !stdout.trim()) {
    return [];
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.toLowerCase().startsWith('id') &&
        !line.startsWith('-')
    )
    .map((line) => {
      const parts = line
        .split(/\s{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        return null;
      }
      const name = parts[1];
      const state = parts[2].toLowerCase();
      return {
        name,
        state,
        running: state.startsWith('running')
      };
    })
    .filter(Boolean);
}

/* -------- Docker helper functions (labels, ports, URLs) -------- */

function parseDockerLabels(rawLabels) {
  if (!rawLabels) return {};
  return rawLabels.split(',').reduce((acc, pair) => {
    const trimmedPair = pair.trim();
    if (!trimmedPair) return acc;
    const idx = trimmedPair.indexOf('=');
    if (idx === -1) return acc;
    const key = trimmedPair.slice(0, idx).trim();
    const value = trimmedPair.slice( idx + 1).trim();
    if (key && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function parseDockerPorts(rawPorts) {
  if (!rawPorts) return [];
  return rawPorts
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/([^:]+)?:?(\d+)->(\d+)(?:\/([a-z]+))?/i);
      if (!match) {
        return { display: segment };
      }
      const hostIp = match[1] && match[1].includes('.') ? match[1] : '0.0.0.0';
      const hostPort = match[2];
      const containerPort = match[3];
      const protocol = match[4] || 'tcp';
      return {
        hostIp,
        hostPort,
        containerPort,
        protocol,
        display: `${hostPort}->${containerPort}/${protocol}`
      };
    });
}

function resolveContainerIp(details) {
  if (!details || !details.NetworkSettings) return null;
  const direct = details.NetworkSettings.IPAddress;
  if (direct) return direct;
  const networks = details.NetworkSettings.Networks;
  if (networks && typeof networks === 'object') {
    for (const net of Object.values(networks)) {
      if (net?.IPAddress) return net.IPAddress;
    }
  }
  return null;
}

function applyDockerTemplate(value, ports = [], context = {}) {
  if (!value || typeof value !== 'string') return value;
  let output = value;

  const resolvedIp = context.containerIp || UNRAID_HOST || 'localhost';

  output = output.replace(/\[IP\]/gi, resolvedIp);
  output = output.replace(/\[PORT:(\d+)\]/gi, (_match, port) => {
    const portNum = Number(port);
    if (!Number.isFinite(portNum)) {
      return port;
    }
    const matched =
      ports.find((p) => Number(p.containerPort) === portNum) ||
      ports.find((p) => Number(p.hostPort) === portNum);
    return matched?.hostPort || String(portNum);
  });

  return output;
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      new URL(trimmed);
      return trimmed;
    }
    if (trimmed.startsWith('//')) {
      const candidate = `http:${trimmed}`;
      new URL(candidate);
      return candidate;
    }
    if (trimmed.startsWith('/')) {
      const base = UNRAID_HOST || 'localhost';
      const candidate = `http://${base}${trimmed}`;
      new URL(candidate);
      return candidate;
    }
    const candidate = `http://${trimmed}`;
    new URL(candidate);
    return candidate;
  } catch {
    console.warn('Invalid Docker URL skipped:', trimmed);
    return null;
  }
}

function deriveDockerUrl(ports, containerIp) {
  if (!Array.isArray(ports) || ports.length === 0) {
    if (containerIp) {
      return `http://${containerIp}`;
    }
    return null;
  }
  const candidate = ports.find((port) => port.hostPort);
  if (candidate) {
    const portNumber = Number(candidate.hostPort);
    const scheme = portNumber === 443 ? 'https' : 'http';
    const base = UNRAID_HOST || 'localhost';
    return `${scheme}://${base}:${candidate.hostPort}`;
  }

  if (containerIp) {
    const containerPort = ports[0]?.containerPort;
    if (containerPort) {
      const portNumber = Number(containerPort);
      const scheme = portNumber === 443 ? 'https' : 'http';
      return `${scheme}://${containerIp}:${containerPort}`;
    }
    return `http://${containerIp}`;
  }

  return null;
}

/* -------- Helpers -------- */

function round(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}



