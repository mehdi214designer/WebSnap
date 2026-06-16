// WebSnap background service worker
// Privileged fetch endpoint that bypasses CORS — capture.js (in page context) can't fetch
// cross-origin images that lack CORS headers, but the background script can thanks to
// host_permissions: <all_urls>.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('WebSnap installed. Click the toolbar icon on any page to capture.');
  }
});

// ---------- Popup presence tracking + capture safety net ----------
// If a capture finishes while the popup is closed, the result has nowhere to go.
// The popup keeps a port open while it's alive; if that port is gone when a result
// arrives, the background auto-downloads the .wsnap so the user's work isn't lost.

let popupConnected = false;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'websnap-popup') {
    popupConnected = true;
    port.onDisconnect.addListener(() => { popupConnected = false; });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Safety net for viewport emulation: if the popup closed mid-capture it can't clear the
  // DevTools override, which would leave the tab attached to the debugger (stuck infobar +
  // emulated size). Detach here so the page always returns to normal. Detaching also clears
  // the override. Only runs when the popup is gone — otherwise the popup handles cleanup.
  if (msg && (msg.type === 'captureResult' || msg.type === 'captureError')) {
    if (!popupConnected && sender && sender.tab && sender.tab.id != null) {
      try { chrome.debugger.detach({ tabId: sender.tab.id }).catch(() => {}); } catch (_e) {}
    }
  }

  if (msg && msg.type === 'captureResult' && msg.result) {
    // Only auto-save if the popup isn't there to handle it
    if (!popupConnected) {
      try {
        autoDownloadWsnap(msg.result);
        chrome.notifications && chrome.notifications.create &&
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-128.png',
            title: 'WebSnap',
            message: 'Capture saved to Downloads (popup was closed).'
          });
      } catch (e) { console.warn('[WebSnap bg] auto-save failed', e); }
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

function autoDownloadWsnap(result) {
  const host = (displayName(result.url) || 'capture').replace(/[^a-z0-9._-]+/gi, '-');
  const time = new Date(result.captured_at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const json = JSON.stringify(result);
  // Service workers can't use URL.createObjectURL on a Blob for downloads reliably;
  // use a data URL instead.
  const dataUrl = 'data:application/json;base64,' + bytesToBase64(new TextEncoder().encode(json));
  chrome.downloads.download({
    url: dataUrl,
    filename: 'WebSnap_' + host + '_' + time + '.wsnap',
    saveAs: false
  });
}

// Friendly name for a captured URL. http(s) -> hostname; file:// -> filename (no extension).
// file:// URLs have an empty hostname, so the name comes from the path instead.
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

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------- Privileged fetch handler ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'fetchAsset') {
    handleFetchAsset(msg.url, msg.as || 'dataUri')
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err && err.message ? err.message : String(err) }));
    return true; // keep the message channel open for async sendResponse
  }
  return false;
});

async function handleFetchAsset(url, as) {
  if (!url) return { error: 'no url' };
  // data: URIs are already self-contained
  if (url.startsWith('data:')) {
    if (as === 'text') {
      const comma = url.indexOf(',');
      const head = url.slice(5, comma);
      const data = url.slice(comma + 1);
      const text = head.includes('base64') ? atob(data) : decodeURIComponent(data);
      return { text };
    }
    return { dataUri: url };
  }
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return { error: 'http ' + res.status };
    const contentType = res.headers.get('content-type') || '';
    if (as === 'text') {
      const text = await res.text();
      return { text, contentType };
    }
    const blob = await res.blob();
    const blobType = (blob.type || contentType || '').toLowerCase();
    const isUnsupportedFormat = blobType.includes('webp') || blobType.includes('avif') ||
      blobType.includes('jxl') || blobType.includes('heic') || blobType.includes('heif');
    const tooBig = blob.size > 8 * 1024 * 1024;

    // Figma createImage() only supports PNG, JPG, and GIF. WebP/AVIF/etc. must be re-encoded.
    // Also downscale anything over 8 MB. Both go through OffscreenCanvas.
    if (isUnsupportedFormat || tooBig) {
      try {
        const bitmap = await createImageBitmap(blob);
        const maxSide = 2400; // generous cap; only downscales truly huge images
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        // PNG keeps transparency + sharp UI screenshots. If the result is huge, fall back to JPEG.
        let outBlob = await canvas.convertToBlob({ type: 'image/png' });
        let outType = 'image/png';
        if (outBlob.size > 3 * 1024 * 1024) {
          outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
          outType = 'image/jpeg';
        }
        const dataUri = await blobToDataUri(outBlob);
        return { dataUri, contentType: outType, converted: isUnsupportedFormat, downscaled: tooBig };
      } catch (e) {
        return { error: 're-encode failed: ' + (e && e.message) };
      }
    }
    const dataUri = await blobToDataUri(blob);
    return { dataUri, contentType };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

self.addEventListener('error', (e) => {
  console.error('[WebSnap bg]', e.message, e.filename, e.lineno);
});
