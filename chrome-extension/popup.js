// WebSnap popup controller
// Handles UI state, triggers captures, manages results and recent history.

// Tell the background worker the popup is alive. If this port drops (popup closed),
// the background knows to auto-save any capture that finishes afterward.
try { chrome.runtime.connect({ name: 'websnap-popup' }); } catch (_e) {}

const state = {
  viewport: 1440,
  mode: 'full',
  theme: 'auto',
  capturing: false,
  lastResult: null,
  activePort: null,
  emuTarget: null
};

const els = {
  viewportButtons: document.querySelectorAll('.viewport-btn'),
  modeButtons: document.querySelectorAll('[data-mode]'),
  themeButtons: document.querySelectorAll('[data-theme]'),
  captureBtn: document.getElementById('capture-btn'),
  abortBtn: document.getElementById('abort-btn'),
  progress: document.getElementById('progress'),
  progressRing: document.querySelector('.progress-ring-fg'),
  progressPct: document.getElementById('progress-pct'),
  progressLabel: document.getElementById('progress-label'),
  result: document.getElementById('result'),
  resultMeta: document.getElementById('result-meta'),
  downloadBtn: document.getElementById('download-btn'),
  copyBtn: document.getElementById('copy-btn'),
  recentSection: document.getElementById('recent-section'),
  recentList: document.getElementById('recent-list'),
  vpCurrent: document.getElementById('vp-current')
};

// ---------- Init ----------

(async function init() {
  // Restore saved state
  const saved = await chrome.storage.local.get(['viewport', 'mode', 'theme']);
  if (saved.viewport) setViewport(saved.viewport);
  if (saved.mode) setMode(saved.mode);
  if (saved.theme) setTheme(saved.theme);

  // Show current tab viewport
  const tab = await getActiveTab();
  if (tab) {
    const dims = await getCurrentViewport(tab.id);
    if (dims) {
      els.vpCurrent.querySelector('.vp-w').textContent = `${dims.width}`;
    }
  }

  // One-time cleanup: strip any heavy `data` payloads from old recent entries
  // (older versions stored full captures here and could blow the storage quota)
  try {
    const { recent = [] } = await chrome.storage.local.get('recent');
    if (recent.some(r => r && r.data)) {
      const cleaned = recent.map(r => ({
        id: r.id, url: r.url, host: r.host, width: r.width, height: r.height,
        nodeCount: r.nodeCount, sizeKB: r.sizeKB, captured_at: r.captured_at
      }));
      await chrome.storage.local.set({ recent: cleaned });
    }
  } catch (e) {
    // If even reading fails, nuke the recent key entirely
    try { await chrome.storage.local.remove('recent'); } catch (_e) {}
  }

  await renderRecent();

  // Wire up UI
  els.viewportButtons.forEach(b => b.addEventListener('click', () => setViewport(b.dataset.width)));
  els.modeButtons.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  els.themeButtons.forEach(b => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  els.captureBtn.addEventListener('click', startCapture);
  els.downloadBtn.addEventListener('click', () => downloadResult());
  els.copyBtn.addEventListener('click', () => copyResult());
  els.abortBtn.addEventListener('click', async () => {
    try { if (state.activePort) state.activePort.disconnect(); } catch (_e) {}
    state.activePort = null;
    await restoreViewport();
    resetUI();
    els.abortBtn.hidden = true;
    toast('Capture cancelled');
  });
})();

// ---------- UI setters ----------

function setViewport(v) {
  state.viewport = v === 'current' ? 'current' : parseInt(v, 10) || 1440;
  els.viewportButtons.forEach(b => {
    const active = String(b.dataset.width) === String(v);
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  chrome.storage.local.set({ viewport: v });
}

function setMode(m) {
  state.mode = m;
  els.modeButtons.forEach(b => {
    const active = b.dataset.mode === m;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  chrome.storage.local.set({ mode: m });
}

function setTheme(t) {
  state.theme = t;
  els.themeButtons.forEach(b => {
    const active = b.dataset.theme === t;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  chrome.storage.local.set({ theme: t });
}

// ---------- Capture flow ----------

async function startCapture() {
  if (state.capturing) return;
  state.capturing = true;

  els.captureBtn.disabled = true;
  els.result.hidden = true;
  els.progress.hidden = false;
  setProgress(0, 'Preparing...');

  const tab = await getActiveTab();
  if (!tab) {
    toast('No active tab');
    resetUI();
    return;
  }

  if (!isCapturable(tab.url)) {
    toast('Cannot capture this page (chrome://, extension, or store pages)');
    resetUI();
    return;
  }

  // Render the page at the chosen viewport width WITHOUT resizing the browser window.
  // Window resizing dismissed the popup (forcing a reopen + recapture) and was jarring.
  // Instead we use the DevTools protocol (chrome.debugger) to emulate the viewport, the
  // same way DevTools responsive mode does, so CSS media queries / breakpoints fire at the
  // target width. The override is cleared automatically once the capture finishes.
  let emuTarget = null;
  if (state.viewport !== 'current' && typeof state.viewport === 'number') {
    try {
      emuTarget = await applyViewportEmulation(tab.id, state.viewport);
      // Give layout a moment to reflow at the emulated width
      await new Promise(r => setTimeout(r, 450));
    } catch (e) {
      // Emulation unavailable (e.g. DevTools already attached to this tab) — fall back
      // to capturing at the current width instead of failing the whole capture.
      console.warn('[WebSnap] viewport emulation failed', e && e.message);
      toast('Viewport emulation unavailable, capturing at current width');
      emuTarget = null;
    }
  }
  state.emuTarget = emuTarget;

  try {
    // Inject the capture script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['capture.js']
    });

    // Listen for progress updates from content
    const port = chrome.tabs.connect(tab.id, { name: 'websnap-capture' });
    state.activePort = port;
    els.abortBtn.hidden = false;

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'progress') {
        setProgress(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        await onCaptureDone(msg.result, tab);
        port.disconnect();
      } else if (msg.type === 'error') {
        toast('Capture failed: ' + (msg.error || 'unknown'));
        await restoreViewport();
        resetUI();
        port.disconnect();
      }
    });

    port.postMessage({
      type: 'start',
      options: {
        viewport: state.viewport,
        mode: state.mode,
        theme: state.theme
      }
    });
  } catch (err) {
    console.error(err);
    toast('Failed to inject capture script');
    await restoreViewport();
    resetUI();
  }
}

// Emulate a viewport width via the DevTools protocol (chrome.debugger). This reflows the
// page at `width` so media queries respond, without touching the real browser window.
// Returns a debuggee target to detach later, or throws if attach/override fails.
async function applyViewportEmulation(tabId, width) {
  // Use the current window height so vertical layout stays natural.
  let height = 900;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.innerHeight
    });
    if (result) height = result;
  } catch (_e) {}

  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: 0, // 0 = keep the host's scale factor
      mobile: false
    });
  } catch (e) {
    // Don't leave the tab in a half-attached state if the override call fails
    try { await chrome.debugger.detach(target); } catch (_e) {}
    throw e;
  }
  return target;
}

// Clear the emulation override and detach. Detaching alone resets the override, but we
// clear first to be explicit. Safe to call with a null target.
async function clearViewportEmulation(target) {
  if (!target) return;
  try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride'); } catch (_e) {}
  try { await chrome.debugger.detach(target); } catch (_e) {}
}

async function restoreViewport() {
  if (state.emuTarget) {
    await clearViewportEmulation(state.emuTarget);
    state.emuTarget = null;
  }
}

async function onCaptureDone(result, tab) {
  state.capturing = false;
  state.lastResult = result;
  state.activePort = null;

  await restoreViewport();

  els.progress.hidden = true;
  els.captureBtn.disabled = false;
  els.abortBtn.hidden = true;

  const sizeKB = Math.round(JSON.stringify(result).length / 1024);
  const nodeCount = countNodes(result.tree);
  const imgInfo = result.stats && result.stats.imagesTotal != null
    ? `${result.stats.images}/${result.stats.imagesTotal} images`
    : `${result.stats && result.stats.images || 0} images`;

  els.resultMeta.innerHTML = `
    <span>${displayName(result.url)}</span>
    <span>${result.viewport.width} x ${result.viewport.height} px</span>
    <span>${nodeCount} nodes, ${sizeKB} KB</span>
    <span>${imgInfo}</span>
  `;
  els.result.hidden = false;

  // Save to recent — METADATA ONLY. Captures can be 10+ MB and chrome.storage.local
  // has a ~10 MB quota, so we never persist the full payload here.
  await addToRecent({
    id: result.id,
    url: result.url,
    host: displayName(result.url),
    width: result.viewport.width,
    height: result.viewport.height,
    nodeCount,
    sizeKB,
    captured_at: result.captured_at
  });

  await renderRecent();
}

function resetUI() {
  state.capturing = false;
  els.captureBtn.disabled = false;
  els.progress.hidden = true;
  els.abortBtn.hidden = true;
}

function setProgress(pct, label) {
  const offset = 100.53 - (pct / 100) * 100.53;
  els.progressRing.style.strokeDashoffset = String(offset);
  els.progressPct.textContent = Math.round(pct) + '%';
  if (label) els.progressLabel.textContent = label;
}

// ---------- Result actions ----------

function downloadResult() {
  if (!state.lastResult) return;
  const blob = new Blob([JSON.stringify(state.lastResult)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const host = displayName(state.lastResult.url).replace(/[^a-z0-9._-]+/gi, '-');
  const time = new Date(state.lastResult.captured_at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  chrome.downloads.download({
    url,
    filename: `WebSnap_${host}_${time}.wsnap`,
    saveAs: false
  });
  toast('Downloading...');
}

async function copyResult() {
  if (!state.lastResult) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.lastResult));
    toast('Copied to clipboard');
  } catch (err) {
    toast('Copy failed');
  }
}

// ---------- Recent ----------

async function addToRecent(entry) {
  // Strip any heavy fields defensively — only keep small metadata
  const meta = {
    id: entry.id,
    url: entry.url,
    host: entry.host,
    width: entry.width,
    height: entry.height,
    nodeCount: entry.nodeCount,
    sizeKB: entry.sizeKB,
    captured_at: entry.captured_at
  };
  try {
    const { recent = [] } = await chrome.storage.local.get('recent');
    const trimmed = [meta].concat(recent).slice(0, 8);
    await chrome.storage.local.set({ recent: trimmed });
  } catch (e) {
    // Storage failure should never crash the capture flow
    console.warn('[WebSnap] could not save recent metadata:', e && e.message);
    try { await chrome.storage.local.set({ recent: [meta] }); } catch (_e) {}
  }
}

async function renderRecent() {
  const { recent = [] } = await chrome.storage.local.get('recent');
  if (!recent.length) {
    els.recentSection.hidden = true;
    return;
  }
  els.recentSection.hidden = false;
  els.recentList.innerHTML = '';
  recent.forEach((r) => {
    const li = document.createElement('li');
    li.className = 'recent-item';
    const time = timeAgo(new Date(r.captured_at));
    li.innerHTML = `
      <div class="recent-meta">
        <span class="recent-host">${r.host}</span>
        <span class="recent-time">${r.width}px, ${r.nodeCount || '?'} nodes, ${time}</span>
      </div>
    `;
    els.recentList.appendChild(li);
  });
}

// ---------- Helpers ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getCurrentViewport(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight })
    });
    return result;
  } catch {
    return null;
  }
}

function isCapturable(url) {
  if (!url) return false;
  // http(s) for live sites, file:// for local HTML files (needs "Allow access to
  // file URLs" enabled on the extension in chrome://extensions).
  return /^(https?|file):/i.test(url);
}

// Friendly name for a captured URL. http(s) -> hostname; file:// -> filename (no extension).
// Used for the result label, recent list, and download filename. file:// URLs have an
// empty hostname, which is why deriving the name from the path matters here.
function displayName(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      const seg = decodeURIComponent(u.pathname).split('/').filter(Boolean).pop() || 'local-file';
      return seg.replace(/\.[a-z0-9]+$/i, '') || 'local-file';
    }
    return u.hostname.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch (_e) {
    return 'capture';
  }
}

function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  if (node.children) node.children.forEach(c => n += countNodes(c));
  return n;
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('visible'), 2200);
}
