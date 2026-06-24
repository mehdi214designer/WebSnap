// WebSnap capture engine
// Runs in the target page. Walks the DOM, extracts geometry, styles, text, images.
// Outputs a tree JSON the Figma plugin can rebuild.

(function () {
  if (window.__websnapInjected) {
    console.log('[WebSnap] capture already loaded');
    return;
  }
  window.__websnapInjected = true;

  // ---------- Constants ----------
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'BR']);
  const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex']);
  const INLINE_TAGS = new Set(['SPAN', 'A', 'STRONG', 'B', 'EM', 'I', 'U', 'SMALL', 'MARK', 'CODE', 'SUB', 'SUP', 'LABEL', 'TIME', 'CITE', 'Q', 'KBD', 'ABBR']);
  // Property-value pairs to keep even when value would otherwise be filtered as "auto" / "none" / "normal"
  const KEEP_AUTO = new Set(['overflow', 'overflow-x', 'overflow-y', 'cursor']);
  const KEEP_NONE = new Set(['text-decoration', 'text-decoration-line']);
  const KEEP_NORMAL = new Set(['font-weight', 'white-space']);

  const STYLE_KEYS = [
    'display', 'position', 'opacity', 'visibility',
    'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
    'background-clip', '-webkit-background-clip',
    'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align',
    'text-transform', 'text-decoration', 'text-decoration-line', 'text-decoration-color',
    'white-space', 'word-spacing',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
    'outline-width', 'outline-style', 'outline-color', 'outline-offset',
    'box-shadow', 'text-shadow', 'backdrop-filter', '-webkit-backdrop-filter',
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-self',
    'justify-content', 'align-items', 'align-content', 'gap', 'row-gap', 'column-gap',
    'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
    'object-fit', 'object-position',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'overflow', 'overflow-x', 'overflow-y',
    'transform', 'filter', 'mix-blend-mode',
    'mask-image', '-webkit-mask-image',
    'z-index', 'cursor'
  ];

  let port = null;
  let assetCounter = 0;
  const assetMap = new Map(); // url -> { id, dataUri }
  const assetPromises = [];

  // ---------- Entry ----------

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== 'websnap-capture') return;
    port = p;
    p.onMessage.addListener(async (msg) => {
      if (msg.type === 'start') {
        try {
          const result = await runCapture(msg.options || {});
          p.postMessage({ type: 'done', result });
          // Safety net: also hand the result to the background worker so it can
          // auto-save if the popup was closed before delivery.
          try { chrome.runtime.sendMessage({ type: 'captureResult', result }); } catch (_e) {}
        } catch (err) {
          console.error('[WebSnap]', err);
          try { p.postMessage({ type: 'error', error: err && err.message ? err.message : String(err) }); } catch (_e) {}
          // Let the background detach the debugger if the popup already closed (so a failed
          // capture never leaves the tab stuck in emulated size).
          try { chrome.runtime.sendMessage({ type: 'captureError' }); } catch (_e) {}
        }
      }
    });
  });

  async function runCapture(options) {
    report(2, 'Preparing page...');

    // Section capture — let the user point-and-click any element on the page; only that
    // element's subtree is captured. Falls back to document.body on cancel.
    let captureRoot = document.body;
    if (options.mode === 'selection') {
      report(4, 'Click any element to capture (Esc to cancel)');
      const picked = await pickElement();
      if (picked) {
        captureRoot = picked;
      } else {
        // User pressed Esc — abort cleanly instead of falling through to a full-page capture
        throw new Error('Selection cancelled');
      }
    }

    // Save original scroll, restore at end
    const originalScroll = { x: window.scrollX, y: window.scrollY };

    // Optional theme override
    let themeStyleEl = null;
    if (options.theme === 'light' || options.theme === 'dark') {
      themeStyleEl = document.createElement('style');
      themeStyleEl.textContent = `:root { color-scheme: ${options.theme} !important; }`;
      document.head.appendChild(themeStyleEl);
      await sleep(120);
    }

    // CRITICAL: disable animations + transitions, force opacity 1 on scroll-reveal initial states.
    // Framer Motion, GSAP, and most scroll-reveal libraries hide elements at opacity:0 + transform
    // until their trigger fires. Forcing the end-state makes them visible immediately.
    const animOverride = document.createElement('style');
    animOverride.setAttribute('data-websnap-override', 'animations');
    animOverride.textContent = `
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        transition-duration: 0.001s !important;
        transition-delay: 0s !important;
      }
      [style*="opacity: 0"], [style*="opacity:0"],
      [style*="visibility: hidden"], [style*="visibility:hidden"] {
        opacity: 1 !important;
        visibility: visible !important;
      }
      [data-framer-appear-id], [data-framer-name] {
        opacity: 1 !important;
        transform: none !important;
        visibility: visible !important;
      }
      /* Common animation library class patterns — force-show */
      .aos-init, .aos-animate,
      [class*="fade-in"], [class*="fadeIn"],
      [class*="slide-up"], [class*="slideUp"],
      [class*="reveal"], [class*="appear"],
      .wow, .animated, .invisible {
        opacity: 1 !important;
        visibility: visible !important;
        transform: none !important;
      }
    `;
    document.head.appendChild(animOverride);
    await sleep(150);

    // Finish any animations currently in progress (page-load reveals)
    finishAllAnimations();
    await sleep(150);

    // Trigger lazy loads by scrolling through the page
    if (options.mode === 'full') {
      report(8, 'Scrolling for lazy content...');
      await scrollThroughPage();
    }

    // Force-finish every JS-driven animation (Web Animations API used by Framer Motion, GSAP).
    // CSS animation-duration overrides don't reach JS animations — getAnimations().finish() does.
    finishAllAnimations();
    await sleep(200);
    // Second pass: any animations created during the first finish (chained reveals)
    finishAllAnimations();
    await sleep(200);

    // Aggressively reset inline opacity:0 and translate transforms that Framer leaves behind
    resetFramerInitialStates();

    // Final settle: give layout, animations, and image decoding time to complete
    await sleep(400);
    try { await document.fonts.ready; } catch (e) {}

    report(25, 'Walking DOM tree...');
    const tree = await buildNode(captureRoot, 0, 1);
    report(70, 'Resolving images...');
    await Promise.all(assetPromises);

    report(92, 'Packaging...');

    // Cleanup overrides
    if (themeStyleEl) themeStyleEl.remove();
    if (animOverride && animOverride.parentNode) animOverride.remove();
    window.scrollTo(originalScroll.x, originalScroll.y);

    // Document dimensions: full page for body captures, the picked element's bounds for
    // selection captures (so the import frame in Figma matches what the user actually picked).
    let docWidth, docHeight;
    if (captureRoot === document.body) {
      docWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0
      );
      docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
    } else {
      const r = captureRoot.getBoundingClientRect();
      docWidth = Math.round(r.width);
      docHeight = Math.round(r.height);
    }

    const assets = {};
    let imagesFetched = 0, imagesFailed = 0;
    assetMap.forEach((v) => {
      assets[v.id] = v.dataUri;
      if (v.dataUri) imagesFetched++;
      else imagesFailed++;
    });

    const result = {
      version: '0.1',
      id: 'snap_' + Math.random().toString(36).slice(2, 10),
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: docWidth, height: docHeight },
      requested_viewport: options.viewport || null,
      theme: options.theme || 'auto',
      captured_at: new Date().toISOString(),
      tree,
      assets,
      stats: {
        nodes: countNodes(tree),
        images: imagesFetched,
        imagesFailed: imagesFailed,
        imagesTotal: imagesFetched + imagesFailed
      }
    };

    report(100, 'Done');
    return result;
  }

  // ---------- DOM walking ----------

  async function buildNode(el, depth, weight) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true' && !hasVisibleSize(el)) return null;

    const styles = window.getComputedStyle(el);
    if (styles.display === 'none' || styles.visibility === 'hidden') return null;
    // Do NOT skip on opacity:0 — many sites use it as the initial state of scroll-reveal animations.
    // The element is still in the layout; render it with the captured opacity so structure is preserved.
    // We only skip if the element ALSO has no children, no text, no image — truly empty + invisible.
    if (parseFloat(styles.opacity) === 0) {
      const hasContent = el.children.length > 0 || (el.textContent || '').trim() || el.tagName === 'IMG' || el.tagName === 'svg';
      if (!hasContent) return null;
      // Bump opacity to 1 so the element shows up in Figma. User can fade later if they want.
      // Capture original opacity for record but render at 1.
    }

    // display: contents → element renders no box; flatten children up
    if (styles.display === 'contents') {
      const flat = [];
      for (const child of el.children) {
        const cn = await buildNode(child, depth + 1, weight);
        if (cn) flat.push(cn);
      }
      // Return a synthetic "transparent" wrapper so the caller can splice children in
      return { __flatten: true, children: flat };
    }

    const rect = el.getBoundingClientRect();
    const docX = rect.left + window.scrollX;
    const docY = rect.top + window.scrollY;

    // Collapsed-panel content (e.g. a closed accordion answer): an in-flow element that
    // vastly overflows a parent collapsed to ~0 height. The live page clips it; without this
    // it renders on top of the visible header (overlapping text). We require the element to be
    // in normal flow (position:static) so Framer's absolutely-positioned content living inside
    // zero-size positioning wrappers is never affected.
    if (rect.height >= 16 && styles.position === 'static') {
      const parentEl = el.parentElement;
      if (parentEl) {
        const pr = parentEl.getBoundingClientRect();
        if (pr.height <= 2 && rect.height - pr.height >= 16) return null;
      }
    }

    // Zero-size handling: only skip if element has NO visible descendants either.
    // Framer wraps content in zero-size positioning containers — keep them as transparent wrappers.
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize && el.tagName !== 'IMG' && !hasInlineTextOnly(el)) {
      // Check descendants for any visible content
      let anyDescendantVisible = false;
      const all = el.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { anyDescendantVisible = true; break; }
      }
      if (!anyDescendantVisible) return null;
      // Treat as a display:contents-style transparent wrapper — flatten children up
      const flat = [];
      for (const child of el.children) {
        const cn = await buildNode(child, depth + 1, weight);
        if (cn) {
          if (cn.__flatten && Array.isArray(cn.children)) {
            for (const g of cn.children) flat.push(g);
          } else {
            flat.push(cn);
          }
        }
      }
      return { __flatten: true, children: flat };
    }

    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: el.className && typeof el.className === 'string' ? el.className : undefined,
      // Naming hints for clean Figma layer names
      alt: (el.getAttribute && el.getAttribute('alt')) || undefined,
      ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || undefined,
      role: (el.getAttribute && el.getAttribute('role')) || undefined,
      rect: {
        x: round(docX),
        y: round(docY),
        w: round(rect.width),
        h: round(rect.height)
      },
      styles: pickStyles(styles, el),
      text: null,
      image: null,
      svg: null,
      children: []
    };

    // Form input value/placeholder handling
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      // Native checkbox/radio: el.value is usually "on" — never render that as text.
      // Only synthesize a control box when the site hasn't custom-styled it.
      const appearance = styles.appearance || styles['-webkit-appearance'] || 'auto';
      const isNative = appearance !== 'none';
      if (isNative) {
        // A native control is OS-drawn, so the captured CSS box is meaningless.
        // Synthesize the standard look unconditionally so it reads correctly in Figma.
        const accent = (styles.accentColor && styles.accentColor !== 'auto')
          ? styles.accentColor : '#2563eb';
        const isRadio = el.type === 'radio';
        node.styles.borderTopWidth = node.styles.borderRightWidth =
        node.styles.borderBottomWidth = node.styles.borderLeftWidth = '1.5px';
        node.styles.borderTopStyle = node.styles.borderRightStyle =
        node.styles.borderBottomStyle = node.styles.borderLeftStyle = 'solid';
        const bc = el.checked ? accent : '#9ca3af';
        node.styles.borderTopColor = node.styles.borderRightColor =
        node.styles.borderBottomColor = node.styles.borderLeftColor = bc;
        const r = isRadio ? '999px' : '3px';
        node.styles.borderTopLeftRadius = node.styles.borderTopRightRadius =
        node.styles.borderBottomLeftRadius = node.styles.borderBottomRightRadius = r;
        if (el.checked) node.styles.backgroundColor = accent;
        else delete node.styles.backgroundColor;
        node.pseudoControl = el.type + (el.checked ? '-checked' : '');
      }
    } else if (el.tagName === 'INPUT' && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && el.type !== 'image') {
      const val = el.value || el.placeholder;
      if (val) {
        node.text = {
          content: val,
          style: extractTextStyle(styles)
        };
      }
    } else if (el.tagName === 'TEXTAREA') {
      const val = el.value || el.placeholder;
      if (val) {
        node.text = { content: val, style: extractTextStyle(styles) };
      }
    } else if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (opt) {
        node.text = { content: opt.textContent || '', style: extractTextStyle(styles) };
      }
    }

    // Image handling
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src;
      if (src) {
        // SVG source — try fetching as text so the plugin can render editable vectors
        const isSvgSrc = /\.svg(\?|$)/i.test(src) || src.startsWith('data:image/svg');
        if (isSvgSrc) {
          const svgText = await fetchAsText(src);
          if (svgText && svgText.includes('<svg')) {
            node.svg = { source: svgText };
          }
        }
        // Always register as raster too (fallback if SVG render fails)
        node.image = await registerAsset(src, el);
      }
    } else if (el.tagName === 'PICTURE') {
      const inner = el.querySelector('img');
      if (inner) {
        const src = inner.currentSrc || inner.src;
        if (src) node.image = await registerAsset(src, inner);
      }
    } else if (el.tagName === 'CANVAS') {
      try {
        const dataUri = el.toDataURL('image/png');
        node.image = await registerAsset(dataUri, el);
      } catch {}
    } else if (el.tagName === 'VIDEO') {
      // Draw the current video frame to a canvas (never store the raw mp4 — Figma can't render it)
      let captured = false;
      try {
        if (el.videoWidth > 0 && el.videoHeight > 0) {
          const canvas = document.createElement('canvas');
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          const cctx = canvas.getContext('2d');
          cctx.drawImage(el, 0, 0);
          const dataUri = canvas.toDataURL('image/png');
          if (dataUri && dataUri.length > 100) {
            node.image = await registerAsset(dataUri, el);
            captured = true;
          }
        }
      } catch (e) {}
      // Fall back to the poster image (an actual image), NOT the video src
      if (!captured && el.poster) {
        node.image = await registerAsset(el.poster, el);
      }
    }

    // Background image handling — supports layered backgrounds (multiple comma-separated layers).
    // ALL gradient layers are collected into `backgroundGradients` so stacked patterns
    // (grid lines = horizontal + vertical gradient layers, page bg = two radial glows, etc.)
    // come through complete. `backgroundGradient` stays set to the first gradient for the
    // gradient-text path and any older render code that still reads the single field.
    const bgImg = styles.backgroundImage;
    if (bgImg && bgImg !== 'none') {
      const layers = splitTopLevelLocal(bgImg, ',');
      const gradients = [];
      for (const rawLayer of layers) {
        const layer = rawLayer.trim();
        if (!layer || layer === 'none') continue;
        if (layer.startsWith('url(')) {
          const urlMatch = layer.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && !node.styles.backgroundAsset) {
            node.styles.backgroundAsset = await registerAsset(urlMatch[1], el);
          }
        } else if (layer.includes('gradient')) {
          const g = parseGradient(layer);
          if (g) gradients.push(g);
        }
      }
      if (gradients.length) {
        node.styles.backgroundGradients = gradients;
        node.styles.backgroundGradient = gradients[0];
      }

      // Tiled / repeating gradients (grid patterns, diagonal stripes, dot grids, etc.)
      // need to render as a small bitmap that Figma can repeat as an IMAGE fill with
      // TILE scale mode — Figma can't natively tile a gradient fill. Detection: any
      // gradient marked `repeating-*`, OR a background-size that's explicit pixels with
      // background-repeat: repeat (the grid-line case on the FluentMembers page).
      const bgSize = styles.backgroundSize || '';
      const bgRepeat = styles.backgroundRepeat || 'repeat';
      const hasRepeatingGrad = gradients.some(function (g) { return g.repeating; });
      const hasTiledSize = /\d+(\.\d+)?(px|em|rem)\s+\d+(\.\d+)?(px|em|rem)/.test(bgSize) &&
                          bgRepeat.indexOf('no-repeat') < 0;
      if ((hasRepeatingGrad || hasTiledSize) && !node.styles.backgroundAsset && gradients.length) {
        const tileSize = parseTileSize(bgSize, gradients[0]);
        if (tileSize) {
          const tileUri = await bakeBackgroundTile(bgImg, tileSize.w, tileSize.h);
          if (tileUri) {
            // Store as backgroundAsset with tile metadata so the renderer picks IMAGE+TILE
            const id = 'asset_' + (++assetCounter);
            assetMap.set('tile-' + id, { id, dataUri: tileUri });
            node.styles.backgroundAsset = { id: id, width: tileSize.w, height: tileSize.h, tile: true };
            // Drop the gradient now that we have a bitmap — render would otherwise paint both
            delete node.styles.backgroundGradients;
            delete node.styles.backgroundGradient;
          }
        }
      }
    }

    // CSS mask-image — Heroicons / Tailwind / Phosphor pattern: an element with a solid
    // background-color and `mask-image: url(icon.svg)` shows the bg color clipped to the
    // SVG silhouette. Without handling, these appear as plain colored rectangles. We fetch
    // the SVG, recolor it with the bg color, and store as the node's editable vector
    // source so it imports into Figma as a real shape.
    const maskRaw = styles.maskImage || styles['-webkit-mask-image'] || styles.getPropertyValue('mask-image') || styles.getPropertyValue('-webkit-mask-image');
    if (maskRaw && maskRaw !== 'none' && /url\(/i.test(maskRaw)) {
      const maskUrlMatch = maskRaw.match(/url\(["']?([^"')]+)["']?\)/);
      if (maskUrlMatch) {
        const maskColor = styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)' && styles.backgroundColor !== 'transparent'
          ? styles.backgroundColor
          : (styles.color || 'rgb(0, 0, 0)');
        const svgText = await fetchAsText(maskUrlMatch[1]);
        if (svgText && svgText.includes('<svg')) {
          node.svg = { source: recolorSvgFill(svgText, maskColor) };
          // The bg color is now expressed via the SVG fill — drop it so the render doesn't
          // also paint a colored rectangle behind the icon.
          delete node.styles.backgroundColor;
        }
      }
    }

    // SVG handling: capture as outerHTML (with class/var()/currentColor styles inlined
    // so the standalone source actually renders), plus rasterize a fallback.
    if (el instanceof SVGElement && el.tagName.toLowerCase() === 'svg') {
      try {
        const svgStr = serializeSvgWithInlinedStyles(el);
        node.svg = { source: svgStr };
        node.image = await rasterizeSvg(el, rect);
      } catch (e) {}
      return node; // don't recurse into svg internals
    }

    // Text vs children decision
    const inlineOnly = isInlineContainer(el);
    if (inlineOnly) {
      const txt = el.innerText || el.textContent || '';
      if (txt.trim()) {
        // Drill down to the element that actually styles the text so we pick up the
        // correct color/font (Framer puts black on the <li> but white on the inner link).
        const textEl = findTextStyleSource(el);
        const textStyles = textEl === el ? styles : window.getComputedStyle(textEl);
        // Icon fonts (Font Awesome, Material Icons, PUA glyphs): rasterize the glyph to a
        // PNG using the page's real font so icons appear in Figma even without the font.
        if (isIconText(textEl, textStyles, txt)) {
          const iconUri = rasterizeGlyph(el, textStyles, txt.trim());
          if (iconUri) {
            node.image = await registerAsset(iconUri, el);
          } else {
            node.text = { content: txt, style: extractTextStyle(textStyles) };
          }
        } else {
          // Capture per-segment runs so mixed inline formatting (a bold/colored word
          // inside a sentence) survives. Only stored when there's more than one distinct run.
          const runs = collectTextRuns(el);
          // Pick up ::before / ::after text-content pseudos (e.g. `::after { content: "%" }`
          // on the `87` LCD). collectTextRuns can't see these — they aren't real text nodes
          // — so we splice them in as runs at the front / back of the parent's text.
          const beforePsRun = getPseudoTextRun(el, '::before');
          const afterPsRun = getPseudoTextRun(el, '::after');
          if (beforePsRun || afterPsRun) {
            const all = [];
            if (beforePsRun) all.push(beforePsRun);
            for (let ri = 0; ri < runs.length; ri++) all.push(runs[ri]);
            if (afterPsRun) all.push(afterPsRun);
            let combined = '';
            for (let ri = 0; ri < all.length; ri++) combined += all[ri].text;
            node.text = {
              content: combined,
              style: extractTextStyle(textStyles),
              runs: all
            };
          } else {
            node.text = {
              content: txt,
              style: extractTextStyle(textStyles),
              runs: runs.length > 1 ? runs : undefined
            };
          }
        }
      }
    } else {
      // ::before decorative box (renders behind content) — prepend
      const beforeNode = await capturePseudoBox(el, '::before');
      if (beforeNode) node.children.push(beforeNode);

      // Recurse into element children
      for (const child of el.children) {
        const cn = await buildNode(child, depth + 1, weight);
        if (!cn) continue;
        if (cn.__flatten && Array.isArray(cn.children)) {
          // display:contents wrapper — splice its children in directly
          for (const grand of cn.children) {
            if (grand.__flatten && Array.isArray(grand.children)) {
              node.children.push(...grand.children);
            } else {
              node.children.push(grand);
            }
          }
        } else {
          node.children.push(cn);
        }
      }
      // Also pick up direct text nodes (e.g. headings with mixed content)
      const directText = collectDirectText(el);
      if (directText.trim()) {
        node.text = {
          content: directText,
          style: extractTextStyle(styles)
        };
      }

      // ::after decorative box (renders on top of content) — append
      const afterNode = await capturePseudoBox(el, '::after');
      if (afterNode) node.children.push(afterNode);
    }

    return node;
  }

  function isInlineContainer(el) {
    // Layout containers (flex/grid/table) are never text containers — they hold child layouts
    const ps = window.getComputedStyle(el);
    if (ps.display === 'flex' || ps.display === 'inline-flex' ||
        ps.display === 'grid' || ps.display === 'inline-grid' ||
        ps.display === 'table' || ps.display === 'table-row' ||
        ps.display === 'table-cell') {
      return false;
    }
    // If ANY descendant is media (image/svg/video/canvas/input/button) or has a background image,
    // this is NOT a pure text container. Collapsing it to text would drop that content.
    if (el.querySelector('img, svg, video, canvas, picture, input, textarea, select, button, iframe')) {
      return false;
    }
    // Check descendants for background images (common for icons/avatars rendered via CSS)
    const descendants = el.querySelectorAll('*');
    for (let i = 0; i < descendants.length; i++) {
      const bg = window.getComputedStyle(descendants[i]).backgroundImage;
      if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) return false;
    }
    if (!el.children.length) {
      // Pure text container
      return (el.textContent || '').trim().length > 0;
    }
    for (const child of el.children) {
      if (INLINE_TAGS.has(child.tagName)) {
        // An inline-block/inline-flex child with a visible background (e.g. a styled pill
        // badge: <span class="badge">) needs its own frame — collapsing it to plain text
        // would discard its background-color and border-radius.
        const cs = window.getComputedStyle(child);
        if ((cs.display === 'inline-block' || cs.display === 'inline-flex') &&
            cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          return false;
        }
        continue;
      }
      const cs = window.getComputedStyle(child);
      if (!INLINE_DISPLAYS.has(cs.display)) return false;
    }
    // It has children but all inline AND no media — treat as text container
    return true;
  }

  function findTextStyleSource(el) {
    // Walk down through wrapper elements that contain the same text, to reach the leaf
    // element that actually carries the text styling (color, font-weight, etc.).
    let cur = el;
    const target = (el.textContent || '').trim();
    if (!target) return el;
    let guard = 0;
    while (cur.children && cur.children.length >= 1 && guard < 20) {
      guard++;
      let next = null;
      for (const child of cur.children) {
        if ((child.textContent || '').trim() === target) { next = child; break; }
      }
      if (next) cur = next;
      else break;
    }
    return cur;
  }

  const ICON_FONT_RE = /(font ?awesome|material icons|material symbols|material-icons|icomoon|fontello|glyphicons|ionicons|feathericons|feather|remixicon|remix icon|bootstrap-icons|phosphor|tabler|lucide|simple-line-icons|themify|dashicons|fa-|fas|far|fab)/i;

  function isIconText(el, styles, txt) {
    const fam = (styles.fontFamily || '').toLowerCase();
    if (ICON_FONT_RE.test(fam)) {
      // The element's font is a dedicated icon font — every glyph it renders is an icon
      // (including ligature names like "home"). Rasterize regardless of length, but cap
      // at a short word so we don't rasterize an entire mis-fonted paragraph.
      return txt.trim().length <= 24;
    }
    // Class-based icon hints (common: <i class="fa fa-user">, <span class="material-icons">)
    const cls = (el.className && typeof el.className === 'string' ? el.className : '') || '';
    if (/\b(fa|fas|far|fab|fal|material-icons|material-symbols|icon|bi|ti|ph|glyphicon|dashicons)\b/.test(cls) && txt.trim().length <= 3) {
      // Only if the text is a glyph-like single token
      const cp0 = txt.trim().codePointAt(0);
      if (cp0 >= 0xE000) return true;
    }
    // Private Use Area glyph (icon fonts map glyphs here)
    const t = txt.trim();
    if (t.length >= 1 && t.length <= 2) {
      for (const ch of t) {
        const cp = ch.codePointAt(0);
        if ((cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0xFFFFD) || (cp >= 0x100000 && cp <= 0x10FFFD)) {
          return true;
        }
      }
    }
    return false;
  }

  // Read a text-content pseudo (e.g. `::after { content: "%" }`) as a text run we can
  // append to the parent's text. Only handles plain string literals — counter(), attr(),
  // and url() pseudos are skipped (the first two are rare in real pages, url() pseudos are
  // already covered as images via the background path).
  function getPseudoTextRun(el, which) {
    let ps;
    try { ps = window.getComputedStyle(el, which); } catch (_e) { return null; }
    if (!ps) return null;
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal') return null;
    const m = content.match(/^["'](.*)["']$/);
    if (!m) return null;
    const text = m[1];
    if (!text) return null;
    return { text: text, style: extractTextStyle(ps) };
  }

  async function capturePseudoBox(el, which) {
    // Conservative pseudo-element capture: only ::before/::after that paint a background
    // (color/image/gradient). These are the common decorative cases (scrims, dividers,
    // overlays, badges). Text-content pseudos are skipped (placement is unreliable).
    let ps;
    try { ps = window.getComputedStyle(el, which); } catch (_e) { return null; }
    if (!ps) return null;
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal') return null;

    const bgColor = ps.backgroundColor;
    const bgImage = ps.backgroundImage;
    const hasBgColor = bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent';
    const hasBgImage = bgImage && bgImage !== 'none';
    if (!hasBgColor && !hasBgImage) return null;

    const parentRect = el.getBoundingClientRect();
    if (parentRect.width === 0 && parentRect.height === 0) return null;

    let w = parseFloat(ps.width) || 0;
    let h = parseFloat(ps.height) || 0;
    const pos = ps.position;
    let x = parentRect.left + window.scrollX;
    let y = parentRect.top + window.scrollY;

    if (pos === 'absolute' || pos === 'fixed') {
      const L = ps.left, R = ps.right, T = ps.top, B = ps.bottom;
      if (!w && L !== 'auto' && R !== 'auto') w = parentRect.width - parseFloat(L) - parseFloat(R);
      if (!h && T !== 'auto' && B !== 'auto') h = parentRect.height - parseFloat(T) - parseFloat(B);
      if (L !== 'auto') x = parentRect.left + window.scrollX + parseFloat(L);
      else if (R !== 'auto') x = parentRect.right + window.scrollX - parseFloat(R) - (w || 0);
      if (T !== 'auto') y = parentRect.top + window.scrollY + parseFloat(T);
      else if (B !== 'auto') y = parentRect.bottom + window.scrollY - parseFloat(B) - (h || 0);
    }
    // Fallback to full-parent overlay if size couldn't be determined
    if (!w) w = parentRect.width;
    if (!h) h = parentRect.height;
    if (w <= 0 || h <= 0) return null;
    // Skip absurdly large pseudos (likely mis-measured)
    if (w > parentRect.width * 4 && h > parentRect.height * 4) return null;

    const styles = {};
    if (hasBgColor) styles.backgroundColor = bgColor;
    if (pos) styles.position = pos;
    // corner radius
    ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'].forEach(function (k) {
      const v = ps.getPropertyValue(k);
      if (v && v !== '0px') styles[camel(k)] = v;
    });
    // opacity
    const op = ps.opacity;
    if (op && op !== '1') styles.opacity = op;
    // box-shadow
    if (ps.boxShadow && ps.boxShadow !== 'none') styles.boxShadow = ps.boxShadow;
    // mix-blend-mode (common for scrims)
    if (ps.mixBlendMode && ps.mixBlendMode !== 'normal') styles.mixBlendMode = ps.mixBlendMode;

    const node = {
      tag: 'pseudo',
      class: 'pseudo' + which.replace(':', '-'),
      rect: { x: round(x), y: round(y), w: round(w), h: round(h) },
      styles: styles,
      text: null, image: null, svg: null, children: []
    };
    // Background image: gradient and/or url() asset (mirror normal bg handling, including
    // multi-layer gradient collection so stacked decorative pseudos come through complete).
    if (hasBgImage) {
      const layers = splitTopLevelLocal(bgImage, ',');
      const gradients = [];
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li].trim();
        if (!layer || layer === 'none') continue;
        if (layer.startsWith('url(')) {
          const urlMatch = layer.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && !node.styles.backgroundAsset) {
            node.styles.backgroundAsset = await registerAsset(urlMatch[1], el);
          }
        } else if (layer.includes('gradient')) {
          const g = parseGradient(layer);
          if (g) gradients.push(g);
        }
      }
      if (gradients.length) {
        node.styles.backgroundGradients = gradients;
        node.styles.backgroundGradient = gradients[0];
      }
    }
    // Drop the node if nothing renderable was actually captured
    if (!hasBgColor && !node.styles.backgroundGradient && !node.styles.backgroundAsset) {
      return null;
    }
    return node;
  }

  function rasterizeGlyph(el, styles, text) {
    try {
      const rect = el.getBoundingClientRect();
      const fs = parseFloat(styles.fontSize) || 16;
      const w = Math.max(1, Math.ceil(rect.width || fs));
      const h = Math.max(1, Math.ceil(rect.height || fs));
      const scale = 3; // crisp on retina
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      const weight = styles.fontWeight || 'normal';
      const fam = styles.fontFamily || 'sans-serif';
      ctx.font = weight + ' ' + fs + 'px ' + fam;
      ctx.fillStyle = styles.color || '#000';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(text, w / 2, h / 2);
      const uri = canvas.toDataURL('image/png');
      return (uri && uri.length > 120) ? uri : null;
    } catch (e) {
      return null;
    }
  }

  function collectTextRuns(el) {
    // Walk text nodes in order; each gets the computed style of its parent element.
    // Merge adjacent runs that share the same key style props to keep the list small.
    const runs = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text && text.replace(/\s+/g, '').length === 0 && text.length) {
          // whitespace-only — keep as-is so spacing between styled words survives
        }
        if (text) {
          const parent = node.parentElement || el;
          const cs = window.getComputedStyle(parent);
          runs.push({ text: text, style: extractTextStyle(cs) });
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        for (const child of node.childNodes) walk(child);
      }
    }
    walk(el);
    // Merge consecutive runs with identical styling
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && sameTextStyle(last.style, r.style)) {
        last.text += r.text;
      } else {
        merged.push({ text: r.text, style: r.style });
      }
    }
    return merged;
  }

  function sameTextStyle(a, b) {
    if (!a || !b) return false;
    return a.color === b.color && a.fontWeight === b.fontWeight &&
      a.fontStyle === b.fontStyle && a.fontSize === b.fontSize &&
      a.fontFamily === b.fontFamily && a.textDecoration === b.textDecoration;
  }

  function collectDirectText(el) {
    let txt = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) txt += child.textContent;
    }
    return txt;
  }

  function hasInlineTextOnly(el) {
    return el.childNodes.length > 0 && [...el.childNodes].every(n => n.nodeType === Node.TEXT_NODE);
  }

  function hasVisibleSize(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- Style extraction ----------

  function pickStyles(cs, el) {
    const out = {};
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k);
      if (!v || v === '') continue;
      const keepAuto = KEEP_AUTO.has(k) && v === 'auto';
      const keepNone = KEEP_NONE.has(k) && v === 'none';
      const keepNormal = KEEP_NORMAL.has(k) && v === 'normal';
      const keepBase = k === 'display' || k === 'position';
      if (v !== 'normal' && v !== 'none' && v !== 'auto') {
        out[camel(k)] = v;
      } else if (keepAuto || keepNone || keepNormal || keepBase) {
        out[camel(k)] = v;
      }
    }
    // Background gradient is parsed per-layer in buildNode (supports multiple layers).
    return out;
  }

  function splitTopLevelLocal(str, sep) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function extractTextStyle(cs) {
    return {
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10) || cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textAlign: cs.textAlign,
      textTransform: cs.textTransform,
      textDecoration: cs.textDecorationLine || cs.textDecoration,
      whiteSpace: cs.whiteSpace
    };
  }

  function parseGradient(bg) {
    // Lightweight gradient detection. Handles repeating-* variants too (treated as base type).
    const norm = bg.replace(/^repeating-/, '');
    const isLinear = norm.startsWith('linear-gradient');
    const isRadial = norm.startsWith('radial-gradient');
    const isConic = norm.startsWith('conic-gradient');
    if (!isLinear && !isRadial && !isConic) return null;
    const inner = bg.slice(bg.indexOf('(') + 1, bg.lastIndexOf(')'));
    return {
      type: isLinear ? 'linear' : isRadial ? 'radial' : 'conic',
      raw: inner,
      repeating: bg.startsWith('repeating-')
    };
  }

  function camel(s) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  // ---------- Image / asset handling ----------

  async function registerAsset(url, el) {
    if (!url) return null;
    if (url.startsWith('data:')) {
      // Dedupe inline data URIs: the same data URI used in multiple places must map to
      // ONE asset id. Without this, each call minted a fresh id but overwrote the same
      // assetMap key, leaving earlier ids dangling (nodes referencing missing assets).
      if (assetMap.has(url)) {
        const cached = assetMap.get(url);
        return { id: cached.id, width: el?.naturalWidth || 0, height: el?.naturalHeight || 0 };
      }
      const id = 'asset_' + (++assetCounter);
      assetMap.set(url, { id, dataUri: url });
      return { id, width: el?.naturalWidth || 0, height: el?.naturalHeight || 0 };
    }
    if (assetMap.has(url)) {
      const cached = assetMap.get(url);
      return { id: cached.id, width: el?.naturalWidth || 0, height: el?.naturalHeight || 0 };
    }
    const id = 'asset_' + (++assetCounter);
    const placeholder = { id, dataUri: null };
    assetMap.set(url, placeholder);
    const p = fetchAsDataUri(url)
      .then(dataUri => {
        placeholder.dataUri = dataUri;
      })
      .catch(() => {
        placeholder.dataUri = null;
      });
    assetPromises.push(p);
    return { id, width: el?.naturalWidth || 0, height: el?.naturalHeight || 0 };
  }

  async function fetchAsDataUri(url) {
    // Strategy 1: privileged background fetch (bypasses CORS via extension host_permissions)
    try {
      const result = await chrome.runtime.sendMessage({ type: 'fetchAsset', url, as: 'dataUri' });
      if (result && result.dataUri) return result.dataUri;
    } catch (e) {
      // sendMessage may fail if background worker is asleep; fall through to page-context attempts
    }
    // Strategy 2: page-context fetch (works for same-origin and CORS-friendly hosts)
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('http ' + res.status);
      const blob = await res.blob();
      if (blob.size > 4 * 1024 * 1024) return await downscaleBlob(blob);
      return await blobToDataUri(blob);
    } catch (e) {}
    // Strategy 3: canvas paint (only works if image is loaded same-origin or has crossorigin attr)
    try {
      const img = await loadImage(url, true);
      return imgToDataUri(img);
    } catch {
      try {
        const img = await loadImage(url, false);
        return imgToDataUri(img);
      } catch {
        return null;
      }
    }
  }

  async function fetchAsText(url) {
    // Privileged background fetch first
    try {
      const result = await chrome.runtime.sendMessage({ type: 'fetchAsset', url, as: 'text' });
      if (result && result.text) return result.text;
    } catch (e) {}
    // Page-context fallback
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) return await res.text();
    } catch (e) {}
    return null;
  }

  function loadImage(url, withCors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (withCors) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = url;
    });
  }

  function imgToDataUri(img) {
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async function downscaleBlob(blob) {
    try {
      const url = URL.createObjectURL(blob);
      const img = await loadImage(url, false);
      URL.revokeObjectURL(url);
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return null;
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

  // ---------- SVG presentation-style inlining ----------
  // Standalone SVGs (after we serialize them) no longer have access to the page's CSS:
  //   - `<path fill="var(--acid)">` loses the variable
  //   - `<circle class="track">` styled via a page `<style>` block loses its stroke
  //   - `currentColor` no longer resolves
  // So before serializing, we clone the SVG and walk both trees in lockstep, copying each
  // element's COMPUTED style into attributes on the clone. The serialized output is then
  // self-contained and renders the same in createNodeFromSvg / OffscreenCanvas as on the page.
  const SVG_INLINE_PROPS = [
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity',
    'opacity', 'stop-color', 'stop-opacity'
  ];
  // Defaults — skip inlining a property when its computed value equals the SVG default,
  // to keep the serialized source small. `fill` is always inlined (see below).
  const SVG_DEFAULTS = {
    'stroke': 'none',
    'stroke-width': '1px',
    'stroke-linecap': 'butt',
    'stroke-linejoin': 'miter',
    'stroke-dasharray': 'none',
    'stroke-dashoffset': '0px',
    'stroke-opacity': '1',
    'fill-opacity': '1',
    'opacity': '1',
    'stop-color': 'rgb(0, 0, 0)',
    'stop-opacity': '1'
  };

  function inlineSvgPresentationStyles(live, clone) {
    if (!live || !clone || live.nodeType !== Node.ELEMENT_NODE) return;
    try {
      const cs = window.getComputedStyle(live);
      for (let i = 0; i < SVG_INLINE_PROPS.length; i++) {
        const prop = SVG_INLINE_PROPS[i];
        const v = cs.getPropertyValue(prop);
        if (!v) continue;
        const trimmed = v.trim();
        if (!trimmed) continue;
        // `fill` is always inlined: the SVG default is black-inherited, but the page's
        // resolved value (after class / var() / currentColor resolution) is what we want.
        if (prop === 'fill') {
          clone.setAttribute('fill', trimmed);
          continue;
        }
        if (SVG_DEFAULTS[prop] && trimmed === SVG_DEFAULTS[prop]) continue;
        clone.setAttribute(prop, trimmed);
      }
      // CSS `transform` on SVG geometry resolves to a matrix. Copy it to the SVG `transform`
      // attribute so rotations / translations (e.g. .ring .prog rotates -90deg) survive
      // outside the page CSS context. Skip the identity / `none` case.
      const tr = cs.transform;
      if (tr && tr !== 'none') clone.setAttribute('transform', tr);
      // Drop class= — it references page CSS that no longer applies.
      if (clone.removeAttribute) clone.removeAttribute('class');
    } catch (_e) {}

    const liveKids = live.children;
    const cloneKids = clone.children;
    const n = Math.min(liveKids.length, cloneKids.length);
    for (let i = 0; i < n; i++) inlineSvgPresentationStyles(liveKids[i], cloneKids[i]);
  }

  // Parse a CSS backgroundSize like "26px 26px" (first layer only) or fall back to a
  // sensible default based on the gradient kind. Returns { w, h } in pixels or null.
  function parseTileSize(bgSize, firstGradient) {
    const sizeFirst = (bgSize || '').split(',')[0].trim();
    const m = sizeFirst.match(/^(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px$/);
    if (m) {
      const w = parseFloat(m[1]);
      const h = parseFloat(m[2]);
      if (w >= 2 && w <= 512 && h >= 2 && h <= 512) return { w: Math.round(w), h: Math.round(h) };
    }
    // Repeating gradient with no explicit size — compute a reasonable tile from the
    // gradient's last stop (heuristic). Cap at 64px to keep the asset small.
    if (firstGradient && firstGradient.repeating) {
      const raw = firstGradient.raw || '';
      const stopMatch = raw.match(/(\d+(?:\.\d+)?)px(?!\w)/g);
      if (stopMatch && stopMatch.length) {
        const max = Math.max.apply(null, stopMatch.map(parseFloat));
        if (max >= 2 && max <= 64) return { w: Math.ceil(max * 2), h: Math.ceil(max * 2) };
      }
    }
    return null;
  }

  // Render a CSS background (gradient or layered gradients) to a small PNG tile using
  // the foreignObject SVG trick: wrap a <div> styled with the CSS background in a
  // <foreignObject>, serialize the SVG, load it as an <img>, and draw it to a canvas.
  // Returns a data URI or null on failure. Used for repeating gradients + tile-sized
  // backgrounds that Figma can then render as an IMAGE fill with TILE scale mode.
  async function bakeBackgroundTile(bgImage, w, h) {
    try {
      // Escape special XML chars in the CSS bg string before stuffing into an SVG attribute.
      const escCss = bgImage.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const svgStr =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;background-image:' + escCss + ';background-size:' + w + 'px ' + h + 'px;background-repeat:no-repeat;"></div>' +
          '</foreignObject>' +
        '</svg>';
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = await new Promise(function (resolve, reject) {
        const i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = reject;
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; // 2x for retina sharpness
      canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUri = canvas.toDataURL('image/png');
      return (dataUri && dataUri.length > 200) ? dataUri : null;
    } catch (_e) {
      return null;
    }
  }

  // Recolor every fillable path in an SVG by setting `fill` on the outer <svg> (cascades
  // to descendants without their own fill) and substituting `currentColor` with the target.
  // Used for CSS mask-image icons, which are typically line-art SVGs with no explicit fill.
  function recolorSvgFill(svgText, color) {
    if (!svgText || !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return svgText;
    let out = svgText;
    // currentColor anywhere in attrs/styles resolves to our target color
    out = out.replace(/currentColor/gi, color);
    // Add fill on outer <svg> tag — inherits to children with no explicit fill of their own
    out = out.replace(/<svg\b([^>]*)>/i, function (_, attrs) {
      if (/\sfill=/i.test(attrs)) return '<svg' + attrs + '>'; // already has fill
      return '<svg fill="' + color + '"' + attrs + '>';
    });
    return out;
  }

  function serializeSvgWithInlinedStyles(svgEl) {
    let clone;
    try { clone = svgEl.cloneNode(true); }
    catch (_e) { return new XMLSerializer().serializeToString(svgEl); }
    inlineSvgPresentationStyles(svgEl, clone);
    return new XMLSerializer().serializeToString(clone);
  }

  async function rasterizeSvg(svg, rect) {
    try {
      const svgStr = serializeSvgWithInlinedStyles(svg);
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; // 2x for retina
      canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUri = canvas.toDataURL('image/png');
      URL.revokeObjectURL(url);
      const id = 'svg_' + (++assetCounter);
      assetMap.set('svg-' + id, { id, dataUri });
      return { id, width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  // ---------- Scrolling ----------

  async function scrollThroughPage() {
    // Step 1: force-load all lazy-loaded images and iframes BEFORE scrolling
    forceLoadLazyAssets();

    // Step 2: do two slow scroll passes to trigger IntersectionObserver-based reveals
    const html = document.documentElement;
    const prevBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';

    const viewport = window.innerHeight;
    // Re-read scrollHeight per loop since content may grow as it loads
    for (let pass = 0; pass < 2; pass++) {
      let total = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      let steps = Math.max(1, Math.ceil(total / (viewport * 0.6)));
      for (let i = 0; i <= steps; i++) {
        const targetY = Math.min(i * viewport * 0.6, total);
        window.scrollTo(0, targetY);
        // Slower step gives IntersectionObserver + lazy-load callbacks time to fire
        await sleep(220);
        // Force-finish any animations that IntersectionObserver just triggered
        finishAllAnimations();
        await sleep(60);
        // Re-read total in case new content was lazy-loaded
        total = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        steps = Math.max(steps, Math.ceil(total / (viewport * 0.6)));
        const overallPct = (pass * 0.5 + (i / steps) * 0.5) * 14;
        report(8 + overallPct, `Scrolling pass ${pass + 1}: ${i + 1}/${steps}`);
      }
      // Re-trigger lazy assets after each pass — new content may have surfaced
      forceLoadLazyAssets();
      await sleep(300);
    }
    // Wait for any remaining images to finish loading
    await waitForImages(3000);
    window.scrollTo(0, 0);
    await sleep(200);
    html.style.scrollBehavior = prevBehavior;
  }

  function finishAllAnimations() {
    // Modern browsers expose document.getAnimations() — returns CSS animations, transitions,
    // and Web Animations API animations (which Framer Motion and GSAP use under the hood).
    try {
      if (typeof document.getAnimations === 'function') {
        const anims = document.getAnimations();
        anims.forEach(function (a) {
          // Infinite animations (logo marquees, ticker scrollers, spinners) cannot "finish".
          // finish() throws for them, AND if a CSS override made them finite, finish() would
          // fast-forward them to fully scrolled (content off-screen). Instead, reset them to
          // the first frame and pause, so the content sits at its natural rest position.
          let infinite = false;
          try {
            const tm = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
            if (tm && tm.iterations === Infinity) infinite = true;
          } catch (_e) {}
          if (infinite) {
            try { a.currentTime = 0; } catch (_e) {}
            try { a.pause(); } catch (_e) {}
          } else {
            // Finite reveal animations: jump to the END (visible) state. Don't pause() —
            // that would freeze mid-flight and capture a random frame.
            try { a.finish(); } catch (_e) {}
          }
        });
      }
      // Trigger scroll listeners that may not have fired
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    } catch (e) {}
  }

  function resetFramerInitialStates() {
    // Walk inline styles. Reset opacity:0 and translate-only transforms to their visible end state.
    // We're careful: only reset patterns that look like animation initial states, not legit transforms.
    document.querySelectorAll('[style]').forEach(function (el) {
      const s = el.style;
      // Reset opacity 0
      if (s.opacity && parseFloat(s.opacity) === 0) {
        s.opacity = '';
      }
      // Reset translate-only transforms (common Framer Motion fade-up pattern: translateY(20px))
      if (s.transform) {
        const t = s.transform;
        // If transform is purely translate (no rotate/scale/skew), reset it
        if (/^[\s]*translate/i.test(t) && !/(rotate|scale|skew|matrix3d|perspective)/i.test(t)) {
          s.transform = '';
        }
        // translate3d common in Framer
        if (/translate3d\([^)]*\)$/.test(t.trim()) && !/(rotate|scale|skew)/i.test(t)) {
          s.transform = '';
        }
      }
      // visibility: hidden as animation initial state
      if (s.visibility === 'hidden') s.visibility = '';
    });
    // Framer-specific data attributes — set element opacity to 1
    document.querySelectorAll('[data-framer-appear-id], [data-framer-name]').forEach(function (el) {
      try { el.style.opacity = ''; el.style.transform = ''; el.style.visibility = ''; } catch (_e) {}
    });
  }

  function forceLoadLazyAssets() {
    // Convert loading="lazy" → "eager" so the browser starts fetching now
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach(function (el) {
      try { el.loading = 'eager'; } catch (_e) {}
    });
    // Copy data-src / data-srcset → src / srcset (common lazy-load pattern across libraries)
    document.querySelectorAll('img[data-src]').forEach(function (img) {
      if (!img.src || img.src.startsWith('data:')) {
        try { img.src = img.dataset.src; } catch (_e) {}
      }
    });
    document.querySelectorAll('img[data-srcset]').forEach(function (img) {
      try { img.srcset = img.dataset.srcset; } catch (_e) {}
    });
    document.querySelectorAll('[data-bg]').forEach(function (el) {
      try { el.style.backgroundImage = 'url(' + el.dataset.bg + ')'; } catch (_e) {}
    });
  }

  function waitForImages(maxMs) {
    return new Promise(function (resolve) {
      const imgs = Array.from(document.images || []);
      if (!imgs.length) return resolve();
      let remaining = imgs.length;
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      const tick = function () {
        remaining--;
        if (remaining <= 0) finish();
      };
      imgs.forEach(function (img) {
        if (img.complete || img.naturalWidth > 0) { tick(); return; }
        img.addEventListener('load', tick, { once: true });
        img.addEventListener('error', tick, { once: true });
      });
      setTimeout(finish, maxMs || 3000);
    });
  }

  // ---------- Utilities ----------

  function countNodes(n) {
    if (!n) return 0;
    let c = 1;
    if (n.children) n.children.forEach(k => c += countNodes(k));
    return c;
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------- Element picker (section capture mode) ----------
  // Show a hover overlay that follows the cursor. Click to pick, Esc to cancel. Returns
  // the chosen element (or null on cancel). The overlay is pointer-events:none so
  // elementFromPoint still hits the real page underneath.
  function pickElement() {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-websnap-overlay', '1');
      overlay.style.cssText =
        'position:fixed;pointer-events:none;border:2px solid #a8ff36;' +
        'background:rgba(168,255,54,0.15);box-shadow:0 0 0 9999px rgba(0,0,0,0.25);' +
        'z-index:2147483647;transition:all 0.08s ease-out;left:0;top:0;width:0;height:0;';
      const label = document.createElement('div');
      label.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#050a05;color:#a8ff36;padding:10px 18px;border-radius:999px;' +
        'border:1px solid #a8ff36;font:600 12px/1 -apple-system,system-ui,sans-serif;' +
        'letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(0,0,0,0.5);' +
        'pointer-events:none;';
      label.textContent = 'Click a section to capture · Esc to cancel';
      document.documentElement.appendChild(overlay);
      document.documentElement.appendChild(label);

      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = 'crosshair';
      let current = null;

      function onMove(e) {
        // elementFromPoint goes through our overlay (pointer-events:none) and finds the
        // real page element at the cursor. Update the overlay to wrap it.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === overlay || el === label || el === current) return;
        current = el;
        const r = el.getBoundingClientRect();
        overlay.style.left = r.left + 'px';
        overlay.style.top = r.top + 'px';
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
      }
      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(current);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          resolve(null);
        }
      }
      function cleanup() {
        try { overlay.remove(); } catch (_e) {}
        try { label.remove(); } catch (_e) {}
        document.body.style.cursor = prevCursor || '';
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  function report(pct, label) {
    if (port) {
      try { port.postMessage({ type: 'progress', pct, label }); } catch {}
    }
  }
})();
