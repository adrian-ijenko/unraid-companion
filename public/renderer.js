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

const elements = {
  host: document.querySelector('[data-host]'),
  updated: document.querySelector('[data-updated]'),
  uptimeTop: document.querySelector('[data-uptime-top]'),
  dashboardLink: document.querySelector('[data-dashboard-link]'),
  cpuValue: document.querySelector('[data-cpu-value]'),
  cpuBar: document.querySelector('[data-cpu-bar]'),
  memValue: document.querySelector('[data-mem-value]'),
  memBar: document.querySelector('[data-mem-bar]'),
  memMeta: document.querySelector('[data-mem-meta]'),
  arrayValue: document.querySelector('[data-array-value]'),
  arrayBar: document.querySelector('[data-array-bar]'),
  arrayMeta: document.querySelector('[data-array-meta]'),
  netIn: document.querySelector('[data-net-in]'),
  netOut: document.querySelector('[data-net-out]'),
  netInterface: document.querySelector('[data-net-interface]'),
  netInterfaceOut: document.querySelector('[data-net-interface-out]'),
  error: document.getElementById('error-banner'),
  refreshButton: document.getElementById('refresh-btn'),
  containersActiveList: document.querySelector('[data-containers-active]'),
  containersInactiveList: document.querySelector('[data-containers-inactive]'),
  containersCount: document.querySelector('[data-container-count]'),
  dockerSection: document.querySelector('[data-docker-section]'),
  dockerInactiveGroup: document.querySelector('[data-docker-inactive]'),
  vmSection: document.querySelector('[data-vm-section]'),
  vmActiveList: document.querySelector('[data-vms-active]'),
  vmInactiveList: document.querySelector('[data-vms-inactive]'),
  vmInactiveGroup: document.querySelector('[data-vm-inactive]'),
  vmCount: document.querySelector('[data-vm-count]'),
  errorScreen: document.querySelector('[data-error-screen]'),
  errorScreenMessage: document.querySelector('[data-error-screen-message]')
};

const settingsElements = {
  overlay: document.getElementById('settings-overlay'),
  form: document.getElementById('settings-form'),
  message: document.querySelector('[data-settings-message]'),
  passwordStatus: document.querySelector('[data-password-status]'),
  openButton: document.getElementById('open-settings'),
  closeButton: document.getElementById('settings-close'),
  cancelButton: document.getElementById('settings-cancel'),
  host: document.getElementById('settings-host'),
  port: document.getElementById('settings-port'),
  username: document.getElementById('settings-username'),
  authMethod: document.getElementById('settings-auth-method'),
  password: document.getElementById('settings-password'),
  privateKey: document.getElementById('settings-private-key'),
  refresh: document.getElementById('settings-refresh'),
  network: document.getElementById('settings-network'),
  dashboard: document.getElementById('settings-dashboard'),
  showDockers: document.getElementById('settings-show-dockers'),
  showVms: document.getElementById('settings-show-vms'),
  showStopped: document.getElementById('settings-show-stopped'),
  clearPassword: document.getElementById('settings-clear-password'),
  errorRetry: document.getElementById('error-retry-btn'),
  errorSettings: document.getElementById('error-settings-btn'),
  transport: document.getElementById('settings-transport'),
  wsUrl: document.getElementById('settings-ws-url')
};

const dragState = {
  fromName: null
};

document.addEventListener('DOMContentLoaded', async () => {
  elements.refreshButton?.addEventListener('click', () => {
    stopCountdown();
    refreshStats(true);
  });
  setupSettingsControls();
  setupDockerReorder();
  await hydrateConfig();
  refreshStats();
});

function connectWebSocket() {
  if (!state.wsUrl) return;
  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) {}
    state.ws = null;
  }

  try {
    const ws = new WebSocket(state.wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      hideError();
    };

    ws.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        renderFromSnapshot(snapshot);
      } catch (err) {
        console.error('Bad WS payload', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error', err);
      showError('WebSocket connection error.');
    };

    ws.onclose = () => {
      state.ws = null;
      if (state.transport === 'ws' && state.wsUrl) {
        setTimeout(connectWebSocket, 5000);
      }
    };
  } catch (err) {
    console.error('Failed to open WebSocket', err);
    showError('Unable to open WebSocket.');
  }
}

async function hydrateConfig() {
  try {
    const config = await window.companion.getConfig();
    if (config?.host) {
      elements.host.textContent = config.hostname || config.host;
    } else {
      elements.host.textContent = 'Host not configured';
    }

    if (config?.refreshIntervalSeconds) {
      state.refreshInterval = config.refreshIntervalSeconds;
    }

    state.networkInterface = config?.networkInterface || 'eth0';
    state.showDockers = config?.showDockerContainers !== false;
    state.showVms = config?.showVmList !== false;
    state.showStoppedServices = Boolean(config?.showStoppedServices);
    state.dockerOrder = Array.isArray(config?.dockerOrder)
      ? config.dockerOrder
      : undefined;
    state.transport = config?.transport || 'ssh';
    state.wsUrl = config?.wsUrl || null;
    state.dashboardUrl = buildDashboardUrl(config);
    setDashboardLink(state.dashboardUrl);
    renderNetwork(null); // reset display until stats arrive
    setSectionVisibility(elements.dockerSection, state.showDockers);
    setSectionVisibility(elements.vmSection, state.showVms);

    // Transport-specific wiring:
    if (state.transport === 'ws' && state.wsUrl) {
      // In WebSocket mode the stream drives updates; no polling / countdown needed.
      connectWebSocket();
      if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
      }
      stopCountdown(true);
    } else {
      // SSH mode – keep existing auto-refresh + countdown behaviour.
      startAutoRefresh();
    }
  } catch (error) {
    showError(error.message || 'Unable to load config.');
  }
}

async function refreshStats(force = false) {
  try {
    if (state.transport === 'ws') {
      // WebSocket stream drives updates; manual "refresh" just retries the connection if needed.
      hideError();
      if (!state.ws && state.wsUrl) {
        connectWebSocket();
      }
      return;
    }

    toggleLoading(true);
    hideError();
    const payload = await window.companion.fetchStats({ force });
    renderStats(payload.stats, payload.cached);
    if (state.refreshTimer) {
      scheduleCountdown();
    }
  } catch (error) {
    showError(error.message || 'Failed to fetch stats.');
  } finally {
    if (state.transport !== 'ws') {
      toggleLoading(false);
    }
  }
}

function renderStats(stats, cached) {
  if (!stats) return;

  if (Number.isFinite(stats.cpuPercent)) {
    elements.cpuValue.textContent = `${stats.cpuPercent.toFixed(1)} %`;
    elements.cpuBar.style.width = `${Math.min(Math.max(stats.cpuPercent, 0), 100)}%`;
  }

  if (stats.memory) {
    const rawUsedPercent = Number.isFinite(stats.memory.usedPercent)
      ? stats.memory.usedPercent
      : Number.isFinite(stats.memory.usedGb) && Number.isFinite(stats.memory.totalGb) && stats.memory.totalGb > 0
        ? (stats.memory.usedGb / stats.memory.totalGb) * 100
        : null;
    const memPercent = Number.isFinite(rawUsedPercent) ? clamp(rawUsedPercent) : 0;

    elements.memValue.textContent = `${memPercent.toFixed(1)} %`;
    elements.memBar.style.width = `${memPercent}%`;

    const usedGbText = Number.isFinite(stats.memory.usedGb)
      ? stats.memory.usedGb.toFixed(1)
      : '--';
    const totalGbText = Number.isFinite(stats.memory.totalGb)
      ? stats.memory.totalGb.toFixed(1)
      : '--';
    elements.memMeta.textContent = `${usedGbText} / ${totalGbText} GB`;
  }

  if (stats.arrayUsage) {
    const arrayPercent = clamp(stats.arrayUsage.usedPercent);
    elements.arrayValue.textContent = `${arrayPercent.toFixed(1)} %`;
    elements.arrayBar.style.width = `${arrayPercent}%`;
    elements.arrayMeta.textContent = `${stats.arrayUsage.usedTb?.toFixed(2) ?? '--'} / ${stats.arrayUsage.totalTb?.toFixed(2) ?? '--'} TB`;
  }

  if (stats.uptimeHuman && elements.uptimeTop) {
    elements.uptimeTop.textContent = `Uptime ${stats.uptimeHuman}`;
  }
  const fetchedDate = stats.fetchedAt ? new Date(stats.fetchedAt) : new Date();
  const suffix = cached ? ' (cached)' : '';
  const humanTime = Number.isNaN(fetchedDate.getTime()) ? 'just now' : fetchedDate.toLocaleTimeString();
  elements.updated.textContent = `Updated ${humanTime}${suffix}`;
  if (stats.hostname) {
    elements.host.textContent = stats.hostname;
    if (!state.dashboardUrl) {
      state.dashboardUrl = buildDashboardUrl({ host: stats.hostname });
      setDashboardLink(state.dashboardUrl);
    }
  }

  renderNetwork(stats.network);
  renderContainers(stats.containers);
  renderVmList(stats.vms);
}

function renderFromSnapshot(snapshot) {
  if (!snapshot) return;
  const host = snapshot.host || {};
  const networkRaw = snapshot.network || null;
  const network = networkRaw
    ? {
        ...networkRaw,
        rxRateMbps:
          Number.isFinite(networkRaw.rxRateMbps) && networkRaw.rxRateMbps >= 0
            ? networkRaw.rxRateMbps
            : Number.isFinite(networkRaw.rxMbps) && networkRaw.rxMbps >= 0
              ? networkRaw.rxMbps
              : null,
        txRateMbps:
          Number.isFinite(networkRaw.txRateMbps) && networkRaw.txRateMbps >= 0
            ? networkRaw.txRateMbps
            : Number.isFinite(networkRaw.txMbps) && networkRaw.txMbps >= 0
              ? networkRaw.txMbps
              : null
      }
    : null;
  const containers = snapshot.containers || [];
  const vms = snapshot.vms || [];
  const arrayUsage = snapshot.arrayUsage || null;

  const stats = {
    cpuPercent: Number.isFinite(host.cpuPercent) ? host.cpuPercent : null,
    uptimeSeconds: host.uptimeSeconds || 0,
    uptimeHuman: formatDuration(host.uptimeSeconds || 0),
    // Use memory object from WS payload as-is; renderStats is defensive about its fields.
    memory: host.memory || null,
    arrayUsage,
    containers,
    vms,
    network,
    hostname: host.hostname || null,
    fetchedAt: snapshot.ts || new Date().toISOString()
  };

  renderStats(stats, false);
}

function startAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
  }
  const intervalMs = Math.max(state.refreshInterval, 5) * 1000;
  state.refreshTimer = setInterval(() => {
    stopCountdown();
    refreshStats(false);
  }, intervalMs);
  scheduleCountdown();
}

function toggleLoading(isLoading) {
  if (!elements.refreshButton) return;
  elements.refreshButton.disabled = isLoading;
  if (isLoading) {
    elements.refreshButton.textContent = 'Refreshing…';
  } else {
    updateRefreshButtonLabel();
  }
}

function showError(message) {
  if (elements.error) {
    elements.error.classList.remove('hidden');
    elements.error.textContent = message;
  }
  if (elements.errorScreen) {
    elements.errorScreen.classList.remove('hidden');
    if (elements.errorScreenMessage) {
      elements.errorScreenMessage.textContent =
        message || 'Please confirm the server is online and reachable over SSH.';
    }
  }
}

function hideError() {
  if (elements.error) {
    elements.error.classList.add('hidden');
  }
  if (elements.errorScreen) {
    elements.errorScreen.classList.add('hidden');
  }
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function renderContainers(containers = []) {
  if (!state.showDockers) {
    setSectionVisibility(elements.dockerSection, false);
    return;
  }
  setSectionVisibility(elements.dockerSection, true);
  if (!elements.containersActiveList || !elements.containersInactiveList) return;

  if (!Array.isArray(containers) || containers.length === 0) {
    elements.containersActiveList.innerHTML =
      '<li class="docker-list__empty">No containers detected.</li>';
    elements.containersInactiveList.innerHTML =
      '<li class="docker-list__empty">No containers detected.</li>';
    if (elements.containersCount) {
      elements.containersCount.textContent = '0 running';
    }
    setSectionVisibility(elements.dockerInactiveGroup, false);
    return;
  }

  const ordered = applyDockerOrder(containers);

  const active = ordered.filter((container) => container.running);
  const inactive = ordered.filter((container) => !container.running);

  renderContainerList(elements.containersActiveList, active, true);
  renderContainerList(elements.containersInactiveList, inactive, false);
  setSectionVisibility(elements.dockerInactiveGroup, state.showStoppedServices && inactive.length > 0);

  if (elements.containersCount) {
    elements.containersCount.textContent = `${active.length}/${containers.length} running`;
  }
}

function renderContainerList(target, items, allowLinks) {
  if (!target) return;
  if (!Array.isArray(items) || items.length === 0) {
    target.innerHTML = '<li class="docker-list__empty">None.</li>';
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((container) => {
    const item = document.createElement('li');
    item.className = 'docker-item';
    item.dataset.containerName = container.name || container.id || '';
    item.draggable = allowLinks;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'docker-button';
    button.title = container.name || container.id || 'Container';

    const canOpen = allowLinks && container.url && container.running;
    if (canOpen) {
      button.addEventListener('click', () => openExternal(container.url));
    } else {
      button.disabled = true;
    }

    const iconWrap = document.createElement('div');
    iconWrap.className = 'docker-button__icon';
    if (container.icon) {
      const img = document.createElement('img');
      img.src = container.icon;
      img.alt = `${container.name || container.id || 'Container'} icon`;
      iconWrap.appendChild(img);
    } else {
      const fallback = document.createElement('span');
      fallback.textContent = (container.name || '?').slice(0, 2).toUpperCase();
      iconWrap.appendChild(fallback);
    }

    const label = document.createElement('span');
    label.className = 'docker-button__label';
    label.textContent = container.name || container.id || 'Unnamed';

    if (container.metrics) {
      const meta = document.createElement('div');
      meta.className = 'docker-button__meta';
      const cpu =
        Number.isFinite(container.metrics.cpuPercent) && container.metrics.cpuPercent >= 0
          ? `${container.metrics.cpuPercent.toFixed(1)}%`
          : '--';
      const inText =
        Number.isFinite(container.metrics.netRxMbps) && container.metrics.netRxMbps >= 0
          ? `${container.metrics.netRxMbps.toFixed(2)} Mbps`
          : '--';
      const outText =
        Number.isFinite(container.metrics.netTxMbps) && container.metrics.netTxMbps >= 0
          ? `${container.metrics.netTxMbps.toFixed(2)} Mbps`
          : '--';

      const cpuSpan = document.createElement('span');
      cpuSpan.textContent = cpu;
      const inSpan = document.createElement('span');
      inSpan.textContent = inText;
      const outSpan = document.createElement('span');
      outSpan.textContent = outText;

      meta.appendChild(cpuSpan);
      meta.appendChild(inSpan);
      meta.appendChild(outSpan);
      button.appendChild(meta);
    }

    const statusPill = buildStatusPill(container.running);

    button.appendChild(iconWrap);
    button.appendChild(label);
    button.appendChild(statusPill);
    item.appendChild(button);
    fragment.appendChild(item);
  });

  target.innerHTML = '';
  target.appendChild(fragment);
}

function renderVmList(vms = []) {
  if (!state.showVms) {
    setSectionVisibility(elements.vmSection, false);
    return;
  }
  setSectionVisibility(elements.vmSection, true);
  if (!elements.vmActiveList || !elements.vmInactiveList) return;

  if (!Array.isArray(vms) || vms.length === 0) {
    elements.vmActiveList.innerHTML = '<li class="vm-list__empty">No VMs detected.</li>';
    elements.vmInactiveList.innerHTML = '<li class="vm-list__empty">No VMs detected.</li>';
    setSectionVisibility(elements.vmInactiveGroup, false);
    if (elements.vmCount) {
      elements.vmCount.textContent = '0 running';
    }
    return;
  }

  const active = vms.filter((vm) => vm.running);
  const inactive = vms.filter((vm) => !vm.running);

  renderVmListSection(elements.vmActiveList, active);
  renderVmListSection(elements.vmInactiveList, inactive);
  setSectionVisibility(elements.vmInactiveGroup, state.showStoppedServices && inactive.length > 0);

  if (elements.vmCount) {
    elements.vmCount.textContent = `${active.length}/${vms.length} running`;
  }
}

function renderVmListSection(target, items) {
  if (!target) return;
  if (!Array.isArray(items) || items.length === 0) {
    target.innerHTML = '<li class="vm-list__empty">None.</li>';
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((vm) => {
    const item = document.createElement('li');
    item.className = 'vm-item';
    const name = document.createElement('span');
    name.textContent = vm.name || 'Unnamed VM';
    const pill = buildStatusPill(vm.running);
    item.appendChild(name);
    item.appendChild(pill);
    fragment.appendChild(item);
  });
  target.innerHTML = '';
  target.appendChild(fragment);
}

function openExternal(url) {
  if (!url) return;
  if (window?.companion?.openExternal) {
    window.companion.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function applyDockerOrder(containers = []) {
  if (!Array.isArray(containers) || !Array.isArray(state.dockerOrder)) {
    return containers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  const orderMap = new Map();
  state.dockerOrder.forEach((name, index) => {
    orderMap.set(name, index);
  });
  return containers
    .slice()
    .sort((a, b) => {
      const aName = a.name || a.id || '';
      const bName = b.name || b.id || '';
      const aIndex = orderMap.has(aName) ? orderMap.get(aName) : Number.POSITIVE_INFINITY;
      const bIndex = orderMap.has(bName) ? orderMap.get(bName) : Number.POSITIVE_INFINITY;
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return aName.localeCompare(bName);
    });
}

function renderNetwork(network) {
  const inbound = Number.isFinite(network?.rxRateMbps) ? network.rxRateMbps : null;
  const outbound = Number.isFinite(network?.txRateMbps) ? network.txRateMbps : null;
  const iface = network?.interface || state.networkInterface || '--';

  if (elements.netIn) {
    elements.netIn.textContent = formatMbps(inbound);
  }
  if (elements.netOut) {
    elements.netOut.textContent = formatMbps(outbound);
  }
  if (elements.netInterface) {
    elements.netInterface.textContent = `Interface ${iface}`;
  }
  if (elements.netInterfaceOut) {
    elements.netInterfaceOut.textContent = `Interface ${iface}`;
  }
}

function buildDashboardUrl(config) {
  if (!config) return null;
  const candidate = config.dashboardUrl || config.webUrl || config.host;
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return `http://${candidate}`;
}

function setDashboardLink(url) {
  if (!elements.dashboardLink) return;
  if (url) {
    elements.dashboardLink.classList.remove('dashboard-link--disabled');
    elements.dashboardLink.onclick = () => openExternal(url);
  } else {
    elements.dashboardLink.classList.add('dashboard-link--disabled');
    elements.dashboardLink.onclick = null;
  }
}

let countdownInterval = null;

function startCountdownLoop() {
  stopCountdown(false);
  countdownInterval = setInterval(updateRefreshButtonLabel, 1000);
  updateRefreshButtonLabel();
}

function stopCountdown(resetTimer = true) {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  if (resetTimer) {
    state.nextRefreshAt = null;
  }
  updateRefreshButtonLabel();
}

function scheduleCountdown() {
  state.nextRefreshAt = Date.now() + Math.max(state.refreshInterval, 5) * 1000;
  startCountdownLoop();
}

function updateRefreshButtonLabel() {
  if (!elements.refreshButton) return;
  if (!state.nextRefreshAt) {
    elements.refreshButton.textContent = 'Refresh';
    return;
  }
  const secondsRemaining = Math.max(
    0,
    Math.ceil((state.nextRefreshAt - Date.now()) / 1000)
  );
  elements.refreshButton.textContent = `Refresh (${secondsRemaining}s)`;
  if (secondsRemaining <= 0) {
    elements.refreshButton.textContent = 'Refresh';
  }
}

function formatMbps(value) {
  if (!Number.isFinite(value) || value < 0) {
    return '-- Mbps';
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} Gbps`;
  }
  return `${value.toFixed(2)} Mbps`;
}

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

function setSectionVisibility(node, shouldShow) {
  if (!node) return;
  node.style.display = shouldShow ? '' : 'none';
}

function buildStatusPill(isRunning) {
  const pill = document.createElement('span');
  pill.className = `status-pill ${isRunning ? 'status-pill--up' : 'status-pill--down'}`;
  return pill;
}

function setupSettingsControls() {
  settingsElements.openButton?.addEventListener('click', openSettingsPanel);
  settingsElements.closeButton?.addEventListener('click', closeSettingsPanel);
  settingsElements.cancelButton?.addEventListener('click', closeSettingsPanel);
  settingsElements.transport?.addEventListener('change', updateSettingsVisibility);
  settingsElements.errorRetry?.addEventListener('click', () => {
    closeSettingsPanel();
    hideError();
    refreshStats(true);
  });
  settingsElements.errorSettings?.addEventListener('click', openSettingsPanel);
  settingsElements.overlay?.addEventListener('click', (event) => {
    if (event.target === settingsElements.overlay) {
      closeSettingsPanel();
    }
  });
  settingsElements.form?.addEventListener('submit', handleSettingsSubmit);
}

function setupDockerReorder() {
  if (!elements.containersActiveList) return;
  elements.containersActiveList.addEventListener('dragstart', (event) => {
    const li = event.target.closest('.docker-item');
    if (!li || !li.dataset.containerName) return;
    dragState.fromName = li.dataset.containerName;
    event.dataTransfer.effectAllowed = 'move';
  });

  elements.containersActiveList.addEventListener('dragover', (event) => {
    if (!dragState.fromName) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  elements.containersActiveList.addEventListener('drop', async (event) => {
    if (!dragState.fromName) return;
    event.preventDefault();
    const li = event.target.closest('.docker-item');
    if (!li || !li.dataset.containerName) {
      dragState.fromName = null;
      return;
    }
    const toName = li.dataset.containerName;
    if (toName === dragState.fromName) {
      dragState.fromName = null;
      return;
    }
    const newOrder = computeNewDockerOrder(dragState.fromName, toName);
    dragState.fromName = null;
    state.dockerOrder = newOrder;

    // Reorder DOM immediately for instant feedback
    const items = Array.from(
      elements.containersActiveList.querySelectorAll('.docker-item[data-container-name]')
    );
    newOrder.forEach((name) => {
      const li = items.find((node) => node.dataset.containerName === name);
      if (li) {
        elements.containersActiveList.appendChild(li);
      }
    });

    // Persist order in the background
    window.companion
      .updateConfig({ dockerOrder: newOrder })
      .catch((error) => console.error('Failed to save docker order', error));
  });
}

function computeNewDockerOrder(fromName, toName) {
  const currentNames = Array.from(
    elements.containersActiveList?.querySelectorAll('.docker-item[data-container-name]') || []
  ).map((li) => li.dataset.containerName);

  // Start from current visual order, then apply move
  const order = currentNames.slice();
  const fromIndex = order.indexOf(fromName);
  const toIndex = order.indexOf(toName);
  if (fromIndex === -1 || toIndex === -1) return order;

  order.splice(fromIndex, 1);
  order.splice(toIndex, 0, fromName);
  return order;
}

async function openSettingsPanel() {
  if (!settingsElements.overlay) return;
  try {
    settingsElements.message.textContent = 'Loading current settings…';
    const editable = await window.companion.getEditableConfig();
    populateSettingsForm(editable);
    settingsElements.overlay.classList.remove('hidden');
    settingsElements.overlay.setAttribute('aria-hidden', 'false');
    settingsElements.message.textContent = '';
  } catch (error) {
    settingsElements.message.textContent = error.message || 'Unable to load settings.';
  }
}

function closeSettingsPanel() {
  if (!settingsElements.overlay) return;
  settingsElements.overlay.classList.add('hidden');
  settingsElements.overlay.setAttribute('aria-hidden', 'true');
  settingsElements.form?.reset();
  if (settingsElements.clearPassword) settingsElements.clearPassword.checked = false;
  if (settingsElements.message) settingsElements.message.textContent = '';
}

function populateSettingsForm(config = {}) {
  if (!settingsElements.form) return;
  settingsElements.host.value = config.host ?? '';
  settingsElements.port.value = config.port ?? '';
  settingsElements.username.value = config.username ?? '';
  settingsElements.authMethod.value = config.authMethod ?? 'password';
  settingsElements.password.value = '';
  settingsElements.privateKey.value = config.privateKeyPath ?? '';
  settingsElements.refresh.value = config.refreshIntervalSeconds ?? '';
  settingsElements.network.value = config.networkInterface ?? '';
  settingsElements.dashboard.value = config.dashboardUrl ?? '';
  if (settingsElements.showDockers) {
    settingsElements.showDockers.checked = config.showDockerContainers !== false;
  }
  if (settingsElements.showVms) {
    settingsElements.showVms.checked = config.showVmList !== false;
  }
  if (settingsElements.showStopped) {
    settingsElements.showStopped.checked = Boolean(config.showStoppedServices);
  }
  if (settingsElements.transport) {
    settingsElements.transport.value = config.transport || 'ssh';
  }
  if (settingsElements.wsUrl) {
    settingsElements.wsUrl.value = config.wsUrl || '';
  }
  if (settingsElements.passwordStatus) {
    settingsElements.passwordStatus.textContent = config.passwordSet
      ? 'Stored password will remain unless changed or cleared.'
      : 'No password saved.';
  }

  updateSettingsVisibility();
}

function updateSettingsVisibility() {
  const mode = settingsElements.transport?.value || 'ssh';
  const sshOnly = document.querySelectorAll('[data-settings-ssh-only]');
  const wsOnly = document.querySelectorAll('[data-settings-ws-only]');

  sshOnly.forEach((node) => {
    node.classList.toggle('settings-field--hidden', mode !== 'ssh');
  });
  wsOnly.forEach((node) => {
    node.classList.toggle('settings-field--hidden', mode !== 'ws');
  });
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  if (!settingsElements.form) return;
  const formData = new FormData(settingsElements.form);
  const payload = {};

  payload.host = formData.get('host')?.toString().trim();
  const portRaw = formData.get('port');
  if (portRaw) payload.port = Number(portRaw);
  payload.username = formData.get('username')?.toString().trim();
  payload.authMethod = formData.get('authMethod')?.toString() || 'password';
  payload.privateKeyPath = formData.get('privateKeyPath')?.toString().trim();
  const refreshRaw = formData.get('refreshIntervalSeconds');
  if (refreshRaw) payload.refreshIntervalSeconds = Number(refreshRaw);
  payload.networkInterface = formData.get('networkInterface')?.toString().trim();
  payload.dashboardUrl = formData.get('dashboardUrl')?.toString().trim();
  payload.showDockerContainers = formData.has('showDockerContainers');
  payload.showVmList = formData.has('showVmList');
  payload.showStoppedServices = formData.has('showStoppedServices');
  payload.transport = formData.get('transport')?.toString() || 'ssh';
  payload.wsUrl = formData.get('wsUrl')?.toString().trim() || '';

  const passwordValue = formData.get('password')?.toString();
  const clearPassword = formData.get('clearPassword') === 'on';
  if (clearPassword) {
    payload.clearPassword = true;
  } else if (passwordValue) {
    payload.password = passwordValue;
  }

  if (settingsElements.message) {
    settingsElements.message.textContent = 'Saving…';
  }

  try {
    const result = await window.companion.updateConfig(payload);
    if (!result?.success) {
      throw new Error(result?.message || 'Failed to update settings.');
    }
    if (settingsElements.message) {
      settingsElements.message.textContent = 'Saved! Reloading stats…';
    }
    await hydrateConfig();
    await refreshStats(true);
    setTimeout(() => {
      closeSettingsPanel();
    }, 800);
  } catch (error) {
    if (settingsElements.message) {
      settingsElements.message.textContent = error.message || 'Failed to save settings.';
    }
  }
}

