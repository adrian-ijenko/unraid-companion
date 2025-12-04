const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client } = require('ssh2');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');
const CONFIG_TEMPLATE = path.join(__dirname, '..', 'config', 'config.example.json');
const MIN_REFRESH_MS = 5_000;

const DEFAULT_CONFIG = {
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'password',
  refreshIntervalSeconds: 30,
  networkInterface: 'eth0',
  showDockerContainers: true,
  showVmList: true,
  showStoppedServices: false,
  transport: 'ssh',
  wsUrl: ''
};

const CONFIG_MUTABLE_FIELDS = [
  'host',
  'port',
  'username',
  'authMethod',
  'password',
  'privateKeyPath',
  'refreshIntervalSeconds',
  'networkInterface',
  'dashboardUrl',
  'showDockerContainers',
  'showVmList',
  'showStoppedServices',
  'dockerOrder',
  'transport',
  'wsUrl'
];

let tray = null;
let trayWindow = null;
let config = loadConfig();
let statsCache = null;
let lastFetchTs = 0;
let lastNetSample = null;
let lastDockerStats = { timestamp: 0, perContainer: new Map() };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (trayWindow) {
    trayWindow.show();
    trayWindow.focus();
  }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.unraid.companion');
  createTrayWindow();
  createTray();
  registerIpcHandlers();
  watchConfig();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('activate', () => {
  if (!trayWindow) {
    createTrayWindow();
  } else {
    trayWindow.show();
  }
});

function createTrayWindow() {
  trayWindow = new BrowserWindow({
    width: 640,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#121212',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  trayWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

  trayWindow.on('blur', () => {
    if (!trayWindow) return;
    trayWindow.hide();
  });

  trayWindow.on('closed', () => {
    trayWindow = null;
  });
}

function createTray() {
  if (tray) return;

  const image = nativeImage.createFromDataURL(buildTrayImage());
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip('Unraid Companion');

  tray.on('click', (_, bounds) => toggleWindow(bounds));
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Refresh Now',
      click: async () => {
        statsCache = null;
        try {
          await fetchStats();
        } catch (err) {
          console.error('Manual refresh failed', err);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open DevTools',
      click: () => {
        if (trayWindow) {
          trayWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);
}

function toggleWindow(bounds) {
  if (!trayWindow) {
    createTrayWindow();
  }

  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }

  const position = calculateWindowPosition(bounds);
  trayWindow.setPosition(position.x, position.y, false);
  trayWindow.show();
  trayWindow.focus();
}

function calculateWindowPosition(bounds = {}) {
  const trayBounds = bounds;
  const windowBounds = trayWindow.getBounds();

  let x = Math.round((trayBounds.x || 0) + ((trayBounds.width || 0) / 2) - windowBounds.width / 2);
  let y = Math.round((trayBounds.y || 0) - windowBounds.height - 10);

  if (x < 0) x = 10;
  if (y < 0) y = (trayBounds.y || 0) + (trayBounds.height || 0) + 10;

  return { x, y };
}

function registerIpcHandlers() {
  ipcMain.handle('stats:fetch', async (_event, options = {}) => {
    const force = Boolean(options.force);
    const intervalMs = Math.max(MIN_REFRESH_MS, (config.refreshIntervalSeconds || 30) * 1000);
    if (!force && statsCache && Date.now() - lastFetchTs < intervalMs) {
      return { stats: statsCache, cached: true };
    }

    const stats = await fetchStats();
    statsCache = stats;
    lastFetchTs = Date.now();

    if (tray) {
      tray.setToolTip(`CPU ${stats.cpuPercent.toFixed(1)}% ▪ Uptime ${stats.uptimeHuman}`);
    }

    return { stats, cached: false };
  });

  ipcMain.handle('config:get', () => sanitizeConfig(config));

  ipcMain.handle('config:edit', () => buildEditableConfig());

  ipcMain.handle('config:update', async (_event, payload = {}) => {
    try {
      const normalized = normalizeConfigPayload(payload);
      persistUserConfig(normalized);
      config = loadConfig();
      statsCache = null;
      lastNetSample = null;
      return { success: true, config: sanitizeConfig(config) };
    } catch (err) {
      console.error('Config update failed:', err);
      return { success: false, message: err.message || 'Unable to update config.' };
    }
  });

  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url !== 'string' || !url.trim()) {
      return false;
    }
    try {
      shell.openExternal(url);
      return true;
    } catch (err) {
      console.error('Failed to open external URL', url, err.message);
      return false;
    }
  });
}

function loadConfig() {
  const fallback = readJson(CONFIG_TEMPLATE) || {};
  const userConfig = readJson(CONFIG_PATH) || {};
  return { ...DEFAULT_CONFIG, ...fallback, ...userConfig };
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Unable to read config file ${filePath}:`, err.message);
    return null;
  }
}

function watchConfig() {
  const configDir = path.dirname(CONFIG_PATH);
  try {
    fs.watch(configDir, { persistent: false }, (_event, filename) => {
      if (filename && filename !== path.basename(CONFIG_PATH)) {
        return;
      }
      config = loadConfig();
      statsCache = null;
      lastNetSample = null;
      console.log('Config reloaded.');
    });
  } catch (err) {
    console.warn('Unable to watch config directory:', err.message);
  }
}

async function fetchStats() {
  ensureConfig();
  const sshConfig = buildSshConfig();
  const conn = new Client();

  return new Promise((resolve, reject) => {
    let resolved = false;

    conn
      .on('ready', async () => {
        try {
          const [
            cpuPercent,
            uptimeSeconds,
            memory,
            arrayUsageRaw,
            hostname,
            containers,
            network,
            vms
          ] = await Promise.all([
            collectCpuPercent(conn),
            collectUptimeSeconds(conn),
            collectMemoryStats(conn),
            collectArrayUsage(conn).catch((err) => {
              console.warn('Array usage fetch failed:', err.message);
              return null;
            }),
            runCommand(conn, 'hostname')
              .then((val) => val.trim())
              .catch(() => config.host),
            config.showDockerContainers
              ? collectDockerContainers(conn).catch((err) => {
                  console.warn('Docker list fetch failed:', err.message);
                  return [];
                })
              : [],
            collectNetworkStats(conn).catch((err) => {
              console.warn('Network stats fetch failed:', err.message);
              return null;
            }),
            config.showVmList
              ? collectVmList(conn).catch((err) => {
                  console.warn('VM list fetch failed:', err.message);
                  return [];
                })
              : []
          ]);

          const stats = {
            cpuPercent,
            uptimeSeconds,
            uptimeHuman: formatDuration(uptimeSeconds),
            memory,
            arrayUsage: arrayUsageRaw || {
              totalTb: 0,
              usedTb: 0,
              usedPercent: 0
            },
            containers: config.showDockerContainers ? containers || [] : [],
            vms: config.showVmList ? vms || [] : [],
            network: network || null,
            hostname: hostname || config.host,
            fetchedAt: new Date().toISOString()
          };

          resolved = true;
          conn.end();
          resolve(stats);
        } catch (err) {
          if (!resolved) {
            resolved = true;
            conn.end();
            reject(err);
          }
        }
      })
      .on('error', (err) => {
        if (!resolved) {
          resolved = true;
          try {
            conn.end();
          } catch (_) {
            conn.destroy();
          }
          reject(err);
        }
      })
      .connect(sshConfig);
  });
}

function ensureConfig() {
  if (!config.host) {
    throw new Error('Host is not configured. Update config/config.json first.');
  }
  if (!config.username) {
    config.username = 'root';
  }
}

function buildSshConfig() {
  const base = {
    host: config.host,
    port: config.port || 22,
    username: config.username || 'root',
    readyTimeout: 8000,
    keepaliveInterval: 2000,
    keepaliveCountMax: 2
  };

  if (config.authMethod === 'key') {
    if (!config.privateKeyPath) {
      throw new Error('privateKeyPath is required for key authentication.');
    }
    const expanded = expandPath(config.privateKeyPath);
    base.privateKey = fs.readFileSync(expanded);
    if (config.password) {
      base.passphrase = config.password;
    }
  } else {
    base.password = config.password;
  }

  return base;
}

async function collectCpuPercent(conn) {
  const first = parseCpuLine(await runCommand(conn, "head -n1 /proc/stat"));
  await delay(400);
  const second = parseCpuLine(await runCommand(conn, "head -n1 /proc/stat"));
  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  const usage = totalDelta === 0 ? 0 : (1 - idleDelta / totalDelta) * 100;
  return clampNumber(usage, 0, 100);
}

async function collectUptimeSeconds(conn) {
  const raw = await runCommand(conn, 'cut -d. -f1 /proc/uptime');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function collectMemoryStats(conn) {
  const meminfo = await runCommand(conn, "grep -E 'MemTotal|MemAvailable|MemFree' /proc/meminfo");
  const parsed = {};
  meminfo
    .trim()
    .split('\n')
    .forEach((line) => {
      const [key, value] = line.split(':');
      parsed[key.trim()] = Number.parseInt(value, 10);
    });

  const totalKb = parsed.MemTotal || 0;
  const freeKb = parsed.MemAvailable ?? parsed.MemFree ?? 0;
  const usedKb = Math.max(totalKb - freeKb, 0);
  const usedPercent = totalKb ? (usedKb / totalKb) * 100 : 0;

  return {
    totalGb: round(totalKb / 1024 / 1024),
    usedGb: round(usedKb / 1024 / 1024),
    usedPercent: clampNumber(usedPercent, 0, 100)
  };
}

async function collectArrayUsage(conn) {
  const df = await runCommand(conn, 'df -B1 /mnt/user | tail -n 1');
  const parts = df.trim().split(/\s+/);
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
    parts[4] && parts[4].endsWith('%') ? Number(parts[4].slice(0, -1)) : fallbackPercent;

  return {
    totalTb: round(totalBytes ? totalBytes / 1024 / 1024 / 1024 / 1024 : 0),
    usedTb: round(usedBytes ? usedBytes / 1024 / 1024 / 1024 / 1024 : 0),
    usedPercent: clampNumber(usedPercent, 0, 100)
  };
}

async function collectNetworkStats(conn) {
  const iface = sanitizeInterfaceName(config.networkInterface) || 'eth0';
  const command = `cat /sys/class/net/${iface}/statistics/rx_bytes; cat /sys/class/net/${iface}/statistics/tx_bytes`;
  const raw = await runCommand(conn, command);
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const rxRaw = tokens[0];
  const txRaw = tokens[1];
  const rxBytes = Number.parseInt(rxRaw, 10);
  const txBytes = Number.parseInt(txRaw, 10);
  if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
    throw new Error(`Unable to parse network stats for interface ${iface}`);
  }

  const now = Date.now();
  let rxRateMbps = null;
  let txRateMbps = null;

  if (lastNetSample && lastNetSample.interface === iface) {
    const deltaMs = Math.max(now - lastNetSample.timestamp, 1);
    const seconds = deltaMs / 1000;
    const rxDelta = Math.max(rxBytes - lastNetSample.rxBytes, 0);
    const txDelta = Math.max(txBytes - lastNetSample.txBytes, 0);
    if (seconds > 0) {
      rxRateMbps = (rxDelta * 8) / seconds / 1_000_000;
      txRateMbps = (txDelta * 8) / seconds / 1_000_000;
    }
  }

  lastNetSample = {
    interface: iface,
    rxBytes,
    txBytes,
    timestamp: now
  };

  return {
    interface: iface,
    rxBytes,
    txBytes,
    rxRateMbps,
    txRateMbps
  };
}

function sanitizeInterfaceName(name) {
  if (!name || typeof name !== 'string') return null;
  return name.replace(/[^a-zA-Z0-9_.:-]/g, '');
}

async function collectDockerContainers(conn) {
  const base = config.showStoppedServices ? 'docker ps -a' : 'docker ps';
  const raw = await runCommand(conn, `${base} --format '{{json .}}' --no-trunc`);
  if (!raw || !raw.trim()) {
    return [];
  }

  const parsed = raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const processed = parsed.map((entry) => ({
    original: entry,
    ports: parseDockerPorts(entry.Ports || ''),
    labels: parseDockerLabels(entry.Labels || '')
  }));

  let runtimeStats = new Map();
  try {
    runtimeStats = await collectDockerRuntimeStats(conn);
  } catch (err) {
    console.warn('docker stats failed:', err.message);
  }

  const inspectMap = await inspectContainers(conn, processed.map((p) => p.original.ID)).catch(
    (err) => {
      console.warn('docker inspect failed:', err.message);
      return new Map();
    }
  );

  return processed.map((entry) => {
    const { original, ports, labels } = entry;
    const details = inspectMap.get(original.ID) || null;
    const containerIp = resolveContainerIp(details);
    const templateContext = { containerIp };
    const explicitUrl = applyDockerTemplate(labels['net.unraid.docker.webui'], ports, templateContext);
    const explicitIcon = applyDockerTemplate(labels['net.unraid.docker.icon'], ports, templateContext);
    const normalizedStatus = (original.Status || '').toLowerCase();
    const isRunning = normalizedStatus.startsWith('up');

    const statsKeyCandidates = [original.ID, original.Names].filter(Boolean);
    let metrics = null;
    for (const key of statsKeyCandidates) {
      if (runtimeStats.has(key)) {
        metrics = runtimeStats.get(key);
        break;
      }
    }

    return {
      id: original.ID,
      name: original.Names,
      image: original.Image,
      status: original.Status,
      running: isRunning,
      ports,
      containerIp,
      url: normalizeUrl(explicitUrl) || deriveDockerUrl(ports, containerIp),
      icon: normalizeUrl(explicitIcon),
      metrics
    };
  });
}

async function collectDockerRuntimeStats(conn) {
  const raw = await runCommand(conn, "docker stats --no-stream --format '{{json .}}'");
  if (!raw || !raw.trim()) return new Map();

  const map = new Map();
  const now = Date.now();
  raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      try {
        const entry = JSON.parse(line);
        const id = entry.Container;
        const name = entry.Name;
        const cpuPercent = parsePercent(entry.CPUPerc);
        const memPercent = parsePercent(entry.MemPerc);
        const { usedBytes: memUsedBytes, totalBytes: memLimitBytes } = parseUsagePair(
          entry.MemUsage
        );
        const { usedBytes: netRxBytes, totalBytes: netTxBytes } = parseUsagePair(entry.NetIO);

        let netRxMbps = null;
        let netTxMbps = null;
        if (lastDockerStats.timestamp && (netRxBytes != null || netTxBytes != null)) {
          const prev = lastDockerStats.perContainer.get(id || name);
          const seconds = (now - lastDockerStats.timestamp) / 1000;
          if (prev && seconds > 0) {
            if (netRxBytes != null && prev.rxBytes != null) {
              netRxMbps = ((netRxBytes - prev.rxBytes) * 8) / seconds / 1_000_000;
            }
            if (netTxBytes != null && prev.txBytes != null) {
              netTxMbps = ((netTxBytes - prev.txBytes) * 8) / seconds / 1_000_000;
            }
          }
        }

        const metrics = {
          cpuPercent,
          memPercent,
          memUsedBytes,
          memLimitBytes,
          netRxBytes,
          netTxBytes,
          netRxMbps,
          netTxMbps
        };

        if (id) map.set(id, metrics);
        if (name) map.set(name, metrics);
      } catch (err) {
        // Ignore malformed stats lines
      }
    });

  // Update last sample for next delta computation
  const nextPerContainer = new Map();
  map.forEach((metrics, key) => {
    nextPerContainer.set(key, {
      rxBytes: metrics.netRxBytes ?? null,
      txBytes: metrics.netTxBytes ?? null
    });
  });
  lastDockerStats = { timestamp: now, perContainer: nextPerContainer };

  return map;
}

async function collectVmList(conn) {
  const command = config.showStoppedServices
    ? 'virsh list --all || true'
    : 'virsh list --state-running || true';
  const raw = await runCommand(conn, command);
  if (!raw || !raw.trim()) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith('id') && !line.startsWith('-'))
    .map((line) => {
      const parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
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

async function inspectContainers(conn, ids = []) {
  if (!ids.length) return new Map();
  const uniqueIds = Array.from(new Set(ids));
  const command = `docker inspect ${uniqueIds.join(' ')}`;
  const output = await runCommand(conn, command);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    console.warn('Unable to parse docker inspect output:', err.message);
    return new Map();
  }

  const map = new Map();
  parsed.forEach((item) => {
    if (!item?.Id) return;
    map.set(item.Id, item);
    const shortId = item.Id.slice(0, 12);
    map.set(shortId, item);
  });
  return map;
}

function parseDockerLabels(rawLabels) {
  if (!rawLabels) return {};
  return rawLabels.split(',').reduce((acc, pair) => {
    const trimmedPair = pair.trim();
    if (!trimmedPair) return acc;
    const idx = trimmedPair.indexOf('=');
    if (idx === -1) return acc;
    const key = trimmedPair.slice(0, idx).trim();
    const value = trimmedPair.slice(idx + 1).trim();
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
    return `${scheme}://${config.host}:${candidate.hostPort}`;
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
      const candidate = `http://${config.host}${trimmed}`;
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

function applyDockerTemplate(value, ports = [], context = {}) {
  if (!value || typeof value !== 'string') return value;
  let output = value;

  const resolvedIp = context.containerIp || config.host;

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

function parsePercent(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().replace('%', '');
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUsagePair(value) {
  if (!value || typeof value !== 'string') {
    return { usedBytes: null, totalBytes: null };
  }
  const parts = value.split('/').map((p) => p.trim());
  if (parts.length < 2) {
    return { usedBytes: parseHumanBytes(parts[0]), totalBytes: null };
  }
  return {
    usedBytes: parseHumanBytes(parts[0]),
    totalBytes: parseHumanBytes(parts[1])
  };
}

function parseHumanBytes(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.trim().match(/^([\d.]+)\s*([kKmMgGtTpP]?i?[bB])?/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || 'B').toLowerCase();

  const multipliers = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  };

  const factor = multipliers[unit] ?? 1;
  return value * factor;
}

function parseCpuLine(line) {
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((num) => Number(num));

  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { idle, total };
}

function sanitizeConfig(rawConfig) {
  const clone = { ...rawConfig };
  if (clone.password) {
    clone.password = '••••••';
  }
  if (clone.privateKeyPath) {
    clone.privateKeyPath = clone.privateKeyPath.replace(os.homedir(), '~');
  }
  return clone;
}

function buildEditableConfig() {
  const editable = { ...config };
  editable.passwordSet = Boolean(config.password);
  editable.password = '';
  return editable;
}

function normalizeConfigPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid config payload.');
  }

  const normalized = {};

  if ('host' in payload) {
    normalized.host = String(payload.host ?? '').trim();
  }

  if ('port' in payload && payload.port !== '' && payload.port !== null && payload.port !== undefined) {
    const port = Number(payload.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535.');
    }
    normalized.port = port;
  }

  if ('username' in payload) {
    normalized.username = String(payload.username ?? '').trim();
  }

  if ('authMethod' in payload) {
    const authMethod = String(payload.authMethod).toLowerCase();
    if (!['password', 'key'].includes(authMethod)) {
      throw new Error('authMethod must be "password" or "key".');
    }
    normalized.authMethod = authMethod;
  }

  if (payload.clearPassword) {
    normalized.password = '';
  } else if ('password' in payload && typeof payload.password === 'string' && payload.password.length) {
    normalized.password = payload.password;
  }

  if ('privateKeyPath' in payload) {
    normalized.privateKeyPath = String(payload.privateKeyPath ?? '').trim();
  }

  if ('refreshIntervalSeconds' in payload && payload.refreshIntervalSeconds !== undefined && payload.refreshIntervalSeconds !== null && payload.refreshIntervalSeconds !== '') {
    const refresh = Number(payload.refreshIntervalSeconds);
    if (!Number.isFinite(refresh) || refresh < 5) {
      throw new Error('Refresh interval must be at least 5 seconds.');
    }
    normalized.refreshIntervalSeconds = Math.round(refresh);
  }

  if ('networkInterface' in payload) {
    normalized.networkInterface = sanitizeInterfaceName(String(payload.networkInterface ?? ''));
  }

  if ('dashboardUrl' in payload) {
    normalized.dashboardUrl = String(payload.dashboardUrl ?? '').trim();
  }

  if ('showDockerContainers' in payload) {
    normalized.showDockerContainers = Boolean(payload.showDockerContainers);
  }

  if ('showVmList' in payload) {
    normalized.showVmList = Boolean(payload.showVmList);
  }

  if ('showStoppedServices' in payload) {
    normalized.showStoppedServices = Boolean(payload.showStoppedServices);
  }

  if (Array.isArray(payload.dockerOrder)) {
    normalized.dockerOrder = payload.dockerOrder
      .map((v) => String(v).trim())
      .filter(Boolean);
  }

  if ('transport' in payload) {
    const t = String(payload.transport || '').toLowerCase();
    if (t === 'ssh' || t === 'ws') {
      normalized.transport = t;
    } else {
      throw new Error('transport must be "ssh" or "ws".');
    }
  }

  if ('wsUrl' in payload) {
    normalized.wsUrl = String(payload.wsUrl ?? '').trim();
  }

  return normalized;
}

function persistUserConfig(patch) {
  if (!patch || Object.keys(patch).length === 0) {
    return;
  }

  const existing = readJson(CONFIG_PATH) || {};
  const next = { ...existing };

  CONFIG_MUTABLE_FIELDS.forEach((field) => {
    if (!(field in patch)) {
      return;
    }
    const value = patch[field];
    if (field === 'password' && value === '') {
      delete next.password;
      return;
    }
    if (value === undefined) {
      delete next[field];
      return;
    }
    next[field] = value;
  });

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}

function runCommand(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';

      stream
        .on('close', (code) => {
          if (code !== 0) {
            const message =
              stderr.trim() || `Command "${command}" failed with exit code ${code}`;
            return reject(new Error(message));
          }
          resolve(stdout);
        })
        .on('data', (data) => {
          stdout += data.toString();
        })
        .on('error', reject);

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

function expandPath(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath.startsWith('~')) {
    return path.join(os.homedir(), targetPath.slice(1));
  }
  return targetPath;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function buildTrayImage() {
  return (
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABQ0lEQVQ4T62Tv0sDQRTHf1MpliYqQiIRbGwsBDd3EwRbWytxJ9hYWKQj+AHsLCzEUlEqGwsrCys7Kws7OxsX8v69t7t7HY5J3d2Zn//5nfmfOA5DJZLKY8f4ES7AMy3Xe2MSpa1JxxKnxU81av1PXIswHq9Ho7j+RsUYHnGcBzH8y7JwBI4R46D0CaU0rXdb5rIpvtdhsF0zQajcZms6GmabquQARBEAR2u93u3Y6nQ7P83BCLFYj4vE4icfjcVqt9sI4jpJOp1PtdlsRqVSSaVSz/OYTCYdDodd1+sdDodisUi/36pqal1u12AwBiNRkqlUoFAoJDg8/mk02m02+2+12m83mTqdDTqdDomE8HmM1mMvlUrVapVSqQhAEASiKoqiL4P8ZxHEcx4EqlUq/X6/X6/V6XS6XK5XKJRCKRCKR/P5fAUBVVUlqtVqtVquVyufz2Qymcwuj0chms8nkcrkcDofD6PV6fL5PHMcRy7LZXKZ/AvlO2cHx7/8oAAAAASUVORK5CYII='
  );
}

