function _slicedToArray(r, e) {
  return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
}
function _nonIterableRest() {
  throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if ("string" == typeof r) return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
  }
}
function _arrayLikeToArray(r, a) {
  (null == a || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
  return n;
}
function _iterableToArrayLimit(r, l) {
  var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
  if (null != t) {
    var e,
      n,
      i,
      u,
      a = [],
      f = !0,
      o = !1;
    try {
      if (i = (t = t.call(r)).next, 0 === l) {
        if (Object(t) !== t) return;
        f = !1;
      } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0);
    } catch (r) {
      o = !0, n = r;
    } finally {
      try {
        if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
      } finally {
        if (o) throw n;
      }
    }
    return a;
  }
}
function _arrayWithHoles(r) {
  if (Array.isArray(r)) return r;
}
function ownKeys(e, r) {
  var t = Object.keys(e);
  if (Object.getOwnPropertySymbols) {
    var o = Object.getOwnPropertySymbols(e);
    r && (o = o.filter(function (r) {
      return Object.getOwnPropertyDescriptor(e, r).enumerable;
    })), t.push.apply(t, o);
  }
  return t;
}
function _objectSpread(e) {
  for (var r = 1; r < arguments.length; r++) {
    var t = null != arguments[r] ? arguments[r] : {};
    r % 2 ? ownKeys(Object(t), !0).forEach(function (r) {
      _defineProperty(e, r, t[r]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) {
      Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r));
    });
  }
  return e;
}
function _defineProperty(e, r, t) {
  return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
    value: t,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[r] = t, e;
}
function _toPropertyKey(t) {
  var i = _toPrimitive(t, "string");
  return "symbol" == typeof i ? i : i + "";
}
function _toPrimitive(t, r) {
  if ("object" != typeof t || !t) return t;
  var e = t[Symbol.toPrimitive];
  if (void 0 !== e) {
    var i = e.call(t, r || "default");
    if ("object" != typeof i) return i;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return ("string" === r ? String : Number)(t);
}
// WebSnap Figma plugin sandbox
// Receives captured JSON from ui.html, rebuilds it as editable Figma nodes.

figma.showUI(__html__, {
  width: 380,
  height: 540,
  themeColors: false
});

// ---------- Message bridge ----------
figma.ui.onmessage = async msg => {
  if (msg.type === 'import') {
    try {
      await runImport(msg.data, msg.options || {});
    } catch (err) {
      console.error('[WebSnap]', err);
      figma.ui.postMessage({
        type: 'error',
        error: err && err.message ? err.message : String(err)
      });
    }
  }
};

// ---------- Constants ----------
const FALLBACK_FONT = {
  family: 'Inter',
  style: 'Regular'
};
const loadedFonts = new Set();
const imageHashCache = new Map(); // data URI -> Figma image hash

// ---------- Entry ----------
async function runImport(data, options) {
  if (!data || !data.tree) throw new Error('This file has no capture data. Re-capture the page.');
  if (!data.tree.children || !data.tree.children.length) {
    throw new Error('The capture is empty — nothing to import. Try re-capturing after the page finishes loading.');
  }
  report(2, 'Loading default font...');
  await loadFontSafe(FALLBACK_FONT);
  report(6, 'Preloading fonts...');
  const fonts = collectFonts(data.tree);
  await preloadFonts(fonts);
  report(20, 'Building root frame...');
  const root = figma.createFrame();
  root.name = nodeName(data, 'WebSnap');
  const docW = Math.max(1, data.document.width);
  const docH = Math.max(1, data.document.height);
  root.x = figma.viewport.center.x - docW / 2;
  root.y = figma.viewport.center.y - docH / 2;
  root.resize(docW, docH);
  // Background — try to match the captured body bg, default white
  const bodyBgRaw = data.tree && data.tree.styles && data.tree.styles.backgroundColor || null;
  const bodyBg = parseColor(bodyBgRaw);
  if (bodyBg && bodyBg.a > 0) {
    root.fills = [{
      type: 'SOLID',
      color: {
        r: bodyBg.r,
        g: bodyBg.g,
        b: bodyBg.b
      },
      opacity: bodyBg.a
    }];
  } else {
    root.fills = [{
      type: 'SOLID',
      color: {
        r: 1,
        g: 1,
        b: 1
      }
    }];
  }
  root.clipsContent = false;

  // Use document origin {0,0} so body's natural margin/position shows naturally
  const rootOrigin = {
    x: 0,
    y: 0
  };
  const ctx = {
    data,
    options,
    assets: data.assets || {},
    stats: {
      nodes: 0,
      errors: 0,
      fontsMissing: new Set()
    }
  };

  // Clean up the tree before rendering: flatten meaningless wrapper divs.
  // Real pages nest content in 3-5x more divs than have visual meaning. Removing the
  // empty passthrough wrappers makes the Figma layer tree navigable and the import faster.
  // Safe in absolute-position mode (children carry document-absolute coords).
  const cleanEnabled = options.cleanLayers !== false;
  if (cleanEnabled && !options.autoLayout) {
    report(22, 'Cleaning up layers...');
    const cleaned = [];
    for (const c of (data.tree.children || [])) {
      for (const s of simplifyNode(c)) cleaned.push(s);
    }
    data.tree.children = cleaned;
  }

  // Walk tree, creating Figma nodes
  await renderChildren(data.tree, root, rootOrigin, ctx, 25, 92);

  // Scroll viewport to show result
  figma.viewport.scrollAndZoomIntoView([root]);
  figma.currentPage.selection = [root];
  report(100, 'Done');

  // Surface missing fonts so the user knows what to install
  const missingFamilies = new Set();
  missingFonts.forEach(function (k) {
    missingFamilies.add(k.split('|')[0]);
  });
  const missingList = Array.from(missingFamilies);

  figma.ui.postMessage({
    type: 'done',
    nodes: ctx.stats.nodes,
    missingFonts: missingList
  });
  let msg = "WebSnap: imported " + ctx.stats.nodes + " layers";
  if (missingList.length) {
    msg += ". Missing fonts: " + missingList.slice(0, 3).join(', ');
    if (missingList.length > 3) msg += " +" + (missingList.length - 3) + " more";
  }
  figma.notify(msg, { timeout: 4000 });
}
function nodeName(data, fallback) {
  try {
    const u = new URL(data.url);
    return "".concat(u.hostname, " \xB7 ").concat(data.viewport.width, "px");
  } catch (_e) {
    return fallback;
  }
}

// ---------- Tree rendering ----------

async function renderChildren(parentTreeNode, parentFigmaNode, parentOrigin, ctx, progStart, progEnd) {
  if (!parentTreeNode.children || !parentTreeNode.children.length) return;
  // CSS Grid layouts use pixel-perfect absolute coords for all children — even in
  // auto-layout mode. Figma's wrap auto-layout can't represent grid-column:span N,
  // asymmetric tracks, or multi-row placement. The captured getBoundingClientRect
  // positions are already the perfect answer, so just use those directly.
  const parentDisplay = parentTreeNode.styles && parentTreeNode.styles.display;
  const isGrid = parentDisplay === 'grid' || parentDisplay === 'inline-grid';
  const useAL = !isGrid && ctx.options.autoLayout && shouldUseAutoLayout(parentTreeNode);

  // Phase 1: create all child Figma nodes (no positioning, no parent attachment yet)
  const built = [];
  const total = parentTreeNode.children.length;
  for (let i = 0; i < total; i++) {
    const child = parentTreeNode.children[i];
    try {
      const fn = await renderNode(child, parentOrigin, ctx);
      if (fn) built.push({
        tn: child,
        fn
      });
    } catch (err) {
      console.warn('[WebSnap] node error:', err && err.message);
      ctx.stats.errors++;
    }
    if (progEnd && total && i % 8 === 0) {
      const pct = progStart + (i + 1) / total * (progEnd - progStart);
      report(pct, "Building layers ".concat(i + 1, "/").concat(total));
    }
    // Yield to the event loop periodically so Figma's UI stays responsive on big imports
    if (ctx.stats.nodes - (ctx._lastYield || 0) >= 120) {
      ctx._lastYield = ctx.stats.nodes;
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Phase 2: attach — in z-index order so CSS stacking is respected.
  // Sites often place a background later in the DOM but behind via low z-index, and
  // foreground content earlier with a high z-index. Figma uses tree order, so we sort
  // by z-index (stable, ties keep DOM order) before appending. Higher z-index = on top.
  const zIndexOf = (x) => {
    const z = x.tn.styles && x.tn.styles.zIndex;
    const n = parseInt(z, 10);
    return isNaN(n) ? 0 : n;
  };
  const orderedForAttach = built
    .map((b, i) => ({ b, i }))
    .sort((a, b) => {
      const dz = zIndexOf(a.b) - zIndexOf(b.b);
      return dz !== 0 ? dz : a.i - b.i;
    })
    .map(x => x.b);
  for (const _ref of orderedForAttach) {
    const fn = _ref.fn;
    try {
      parentFigmaNode.appendChild(fn);
    } catch (e) {
      ctx.stats.errors++;
    }
  }

  // Phase 3: position / auto layout
  if (useAL && parentFigmaNode.type === 'FRAME') {
    // Split into in-flow vs absolutely positioned
    const isAbs = x => {
      const p = x.tn.styles && x.tn.styles.position;
      return p === 'absolute' || p === 'fixed';
    };
    const inFlow = built.filter(x => !isAbs(x));
    const absChildren = built.filter(isAbs);

    // Sort in-flow children along the primary axis to preserve visual order
    const dir = parentTreeNode.styles.flexDirection || 'row';
    const horiz = !dir.startsWith('column');
    const reverse = dir.endsWith('reverse');
    const sortKey = horiz ? 'x' : 'y';
    const sortedFlow = [...inFlow].sort((a, b) => a.tn.rect[sortKey] - b.tn.rect[sortKey]);
    if (reverse) sortedFlow.reverse();
    for (const _ref2 of sortedFlow) {
      const fn = _ref2.fn;
      try {
        parentFigmaNode.appendChild(fn);
      } catch (_e) {}
    }
    applyAutoLayout(parentFigmaNode, parentTreeNode, ctx, inFlow.map(x => x.fn));

    // Absolute / fixed children opt out of auto-layout flow
    for (const _ref3 of absChildren) {
      const tn = _ref3.tn;
      const fn = _ref3.fn;
      try {
        fn.layoutPositioning = 'ABSOLUTE';
        fn.x = tn.rect.x - parentOrigin.x;
        fn.y = tn.rect.y - parentOrigin.y;
      } catch (e) {
        ctx.stats.errors++;
      }
    }
  } else {
    for (const _ref4 of built) {
      const tn = _ref4.tn;
      const fn = _ref4.fn;
      try {
        fn.x = tn.rect.x - parentOrigin.x;
        fn.y = tn.rect.y - parentOrigin.y;
      } catch (_e) {}
    }
  }

  // Auto-detect carousel/marquee/scroller overflow:
  // If children extend significantly past the parent's bounds in either direction,
  // force clipping. Real CSS often uses JS-driven transforms to clip rather than overflow:hidden,
  // which means our captured overflow value lies. This heuristic catches that.
  try {
    if ('clipsContent' in parentFigmaNode && parentFigmaNode.children.length > 0) {
      let maxRight = 0, maxBottom = 0;
      for (let i = 0; i < parentFigmaNode.children.length; i++) {
        const c = parentFigmaNode.children[i];
        const cx = (c.x || 0), cy = (c.y || 0);
        const cw = (c.width || 0), ch = (c.height || 0);
        if (cx + cw > maxRight) maxRight = cx + cw;
        if (cy + ch > maxBottom) maxBottom = cy + ch;
      }
      const pw = parentFigmaNode.width || 0;
      const ph = parentFigmaNode.height || 0;
      const overflowsH = pw > 0 && maxRight > pw * 1.5;
      const overflowsV = ph > 0 && maxBottom > ph * 1.5;
      if (overflowsH || overflowsV) {
        try { parentFigmaNode.clipsContent = true; } catch (_e) {}
      }
    }
  } catch (_e) {}

  // Bring position:fixed / sticky children to the front (top of z-order).
  // CSS gives these high stacking; Figma uses tree order, so without this a fixed header
  // ends up behind later siblings like a full-bleed hero image.
  try {
    for (const _ref of built) {
      const pos = _ref.tn.styles && _ref.tn.styles.position;
      if (pos === 'fixed' || pos === 'sticky') {
        try { parentFigmaNode.appendChild(_ref.fn); } catch (_e) {}
      }
    }
  } catch (_e) {}
}
// Turn an element's loose direct text into a real text-leaf child so it renders
// alongside its element children (icon + label rows). Placed to the right of the
// existing children (the common icon-then-label case), vertically centered.
function injectDirectTextChild(tn) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, any = false;
  for (let i = 0; i < tn.children.length; i++) {
    const c = tn.children[i];
    if (!c || !c.rect) continue;
    const cw = c.rect.w || 0, chh = c.rect.h || 0;
    if (cw <= 0 && chh <= 0) continue;
    any = true;
    if (c.rect.x < left) left = c.rect.x;
    if (c.rect.x + cw > right) right = c.rect.x + cw;
    if (c.rect.y < top) top = c.rect.y;
    if (c.rect.y + chh > bottom) bottom = c.rect.y + chh;
  }
  const s = tn.styles || {};
  const ts = (tn.text && tn.text.style) || {};
  const fs = parseFloat(ts.fontSize) || 16;
  const lineH = Math.max(1, Math.round(fs * 1.35));
  const gap = parseFloat(s.columnGap || s.gap) || 8;
  const padL = parseFloat(s.paddingLeft) || 0;
  const padR = parseFloat(s.paddingRight) || 0;

  let tx, ty, tw;
  if (any) {
    tx = right + gap;
    const cCenter = (top + bottom) / 2;
    ty = Math.round(cCenter - lineH / 2);
    tw = Math.max(8, (tn.rect.x + tn.rect.w - padR) - tx);
  } else {
    tx = tn.rect.x + padL;
    ty = Math.round(tn.rect.y + (tn.rect.h - lineH) / 2);
    tw = Math.max(8, tn.rect.w - padL - padR);
  }

  // Clone the text style and force single-line so font substitution can't wrap a label.
  // Left-align so the label sits right after the icon (don't inherit a centered box).
  const style = {};
  for (const k in ts) { if (Object.prototype.hasOwnProperty.call(ts, k)) style[k] = ts[k]; }
  style.whiteSpace = 'nowrap';
  style.textAlign = 'left';

  tn.children.push({
    tag: '#text',
    rect: { x: Math.round(tx), y: Math.round(ty), w: Math.round(tw), h: lineH },
    styles: {},
    text: { content: tn.text.content, style: style },
    children: []
  });
  // The text now lives as a child — clear the parent's own text so it isn't handled twice.
  tn.text = null;
}

async function renderNode(tn, parentOrigin, ctx) {
  if (!tn) return null;
  ctx.stats.nodes++;
  const w = Math.max(1, Math.round(tn.rect.w));
  const h = Math.max(1, Math.round(tn.rect.h));
  let node = null;

  // An element can carry BOTH its own direct text AND child elements, e.g.
  // <button><svg/>Forest Calm</button> — an icon plus a loose label. The browser lays
  // the text out next to the icon; this renderer used to draw the icon (as a frame with
  // children) and silently drop the text. Synthesize a text-leaf child so the label
  // renders and positions like any other child.
  if (tn.text && tn.text.content && tn.children && tn.children.length) {
    injectDirectTextChild(tn);
  }

  // Text node — leaf with text content
  if (tn.text && tn.text.content && (!tn.children || !tn.children.length)) {
    // If this text-leaf also has visual styling (bg color, bg image, gradient, border, shadow),
    // wrap it in a frame so the styling renders.
    // EXCEPTION: gradient text (background-clip:text) — the gradient goes on the text itself,
    // not a backing frame, so don't treat it as a background.
    const bgClipText = (() => {
      const bc = (tn.styles && (tn.styles.backgroundClip || tn.styles.webkitBackgroundClip)) || '';
      return bc.indexOf('text') >= 0;
    })();
    const hasBg = (() => {
      if (bgClipText) return false; // gradient/clipped text handled in createTextNode
      const c = parseColor(tn.styles && tn.styles.backgroundColor);
      if (c && c.a > 0) return true;
      if (tn.styles && (tn.styles.backgroundAsset || tn.styles.backgroundGradient || (tn.styles.backgroundGradients && tn.styles.backgroundGradients.length))) return true;
      if (tn.styles && tn.styles.boxShadow && tn.styles.boxShadow !== 'none') return true;
      const s = tn.styles || {};
      // Any side border, or any corner radius
      const anyBorder = ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth']
        .some(k => (parseFloat(s[k]) || 0) > 0);
      const anyRadius = ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']
        .some(k => (parseFloat(s[k]) || 0) > 0);
      if (anyBorder || anyRadius) return true;
      return false;
    })();
    const txt = await createTextNode(tn);
    if (!txt) {
      node = figma.createRectangle();
      node.resize(w, h);
      applyVisualStyles(node, tn, ctx);
    } else if (hasBg) {
      // Text-with-background leaves (buttons, inputs, badges, pills) — wrap in an Auto
      // Layout frame so the text uses real CSS padding and centers correctly, instead of
      // sitting at fixed (x,y) coords. Without this, every button comes out as a plain
      // Frame with text floating inside, and resizing the button doesn't reflow the text.
      const frame = figma.createFrame();
      frame.resize(w, h);
      applyVisualStyles(frame, tn, ctx);
      frame.appendChild(txt);
      if (ctx.options.autoLayout) {
        try {
          const pl = parseFloat(tn.styles.paddingLeft) || 0;
          const pr = parseFloat(tn.styles.paddingRight) || 0;
          const pt = parseFloat(tn.styles.paddingTop) || 0;
          const pb = parseFloat(tn.styles.paddingBottom) || 0;
          frame.layoutMode = 'HORIZONTAL';
          frame.primaryAxisSizingMode = 'FIXED';
          frame.counterAxisSizingMode = 'FIXED';
          frame.primaryAxisAlignItems = 'CENTER';
          frame.counterAxisAlignItems = 'CENTER';
          frame.paddingLeft = pl;
          frame.paddingRight = pr;
          frame.paddingTop = pt;
          frame.paddingBottom = pb;
          // Honor the text node's own alignment (e.g. text-align:left button) by setting
          // the primary-axis alignment to match.
          const ta = (tn.text && tn.text.style && tn.text.style.textAlign) || '';
          if (ta === 'left' || ta === 'start') frame.primaryAxisAlignItems = 'MIN';
          else if (ta === 'right' || ta === 'end') frame.primaryAxisAlignItems = 'MAX';
        } catch (_e) {
          // AL setup failed (e.g. fonts not loaded for layoutMode side-effects). Fall back
          // to absolute positioning so the text still lands inside the frame.
          try {
            const pl = parseFloat(tn.styles.paddingLeft) || 0;
            const pt = parseFloat(tn.styles.paddingTop) || 0;
            txt.x = pl;
            txt.y = pt;
          } catch (_e2) { txt.x = 0; txt.y = 0; }
        }
      } else {
        // Pixel-perfect mode — keep the old absolute positioning of text inside the frame
        try {
          const pl = parseFloat(tn.styles.paddingLeft) || 0;
          const pt = parseFloat(tn.styles.paddingTop) || 0;
          txt.x = pl;
          txt.y = pt;
        } catch (_e) { txt.x = 0; txt.y = 0; }
      }
      node = frame;
    } else {
      node = txt;
    }
  } else if (tn.svg && tn.svg.source && ctx.options.images !== false) {
    // SVGs that contain <text> render unreliably through Figma's SVG import: the font
    // gets substituted and the text wraps mid-word (e.g. a cover-art "Breathe" became
    // "Brea/the"). The capture already rasterized the SVG with the real page font, so
    // prefer that raster for text-bearing SVGs. Icon SVGs (no text) stay editable vectors.
    const svgHasText = /<text[\s>]/i.test(tn.svg.source);
    if (svgHasText && tn.image && tn.image.id) {
      node = await createImageRect(tn, ctx);
    }
    if (!node) {
      node = await createSvgNode(tn, w, h, ctx);
    }
    if (!node && tn.image && tn.image.id) {
      node = await createImageRect(tn, ctx);
    }
    if (!node) {
      node = figma.createRectangle();
      node.resize(w, h);
      applyVisualStyles(node, tn, ctx);
    }
  } else if (tn.image && tn.image.id && ctx.options.images !== false) {
    node = await createImageRect(tn, ctx);
  } else if (tn.children && tn.children.length) {
    // Frame with children
    node = figma.createFrame();
    node.resize(w, h);
    applyVisualStyles(node, tn, ctx);
    // Recurse
    await renderChildren(tn, node, {
      x: tn.rect.x,
      y: tn.rect.y
    }, ctx, 0, 0);
  } else {
    // Leaf — rectangle
    node = figma.createRectangle();
    node.resize(w, h);
    applyVisualStyles(node, tn, ctx);
  }
  if (!node) return null;
  try {
    node.name = makeName(tn);
  } catch (_e) {}
  // Apply CSS transform (rotate, etc.)
  applyTransform(node, tn);
  // Apply CSS filter (drop-shadow, blur)
  applyFilter(node, tn);
  return node;
}

// Sentinel color we substitute for `currentColor` before handing the SVG to Figma's
// importer. After import we find vectors painted with this exact color and swap them
// for the real CSS color — this preserves any hard-coded fills in multi-color SVGs.
// The value is intentionally an obscure off-yellow no real designer picks.
const CURRENT_COLOR_SENTINEL = '#fefe01';
const SENTINEL_RGB = { r: 254/255, g: 254/255, b: 1/255 };

function isSentinelColor(c) {
  if (!c) return false;
  return Math.abs(c.r - SENTINEL_RGB.r) < 0.01
      && Math.abs(c.g - SENTINEL_RGB.g) < 0.01
      && Math.abs(c.b - SENTINEL_RGB.b) < 0.01;
}

async function createSvgNode(tn, w, h, ctx) {
  // Pre-process source: substitute currentColor with a sentinel so we can find and replace
  // ONLY those paths after Figma imports the vectors. The previous blanket-recolor mode
  // overwrote every fill in the SVG when any single path used currentColor — that broke
  // multi-color icons where currentColor was just one of several intentional fills.
  const rawSource = tn.svg.source || '';
  const sourceUsesCurrentColor = /currentcolor/i.test(rawSource);
  const processedSource = sourceUsesCurrentColor
    ? rawSource.replace(/currentColor/gi, CURRENT_COLOR_SENTINEL)
    : rawSource;

  let svgNode = null;
  // The async variant throws on property access in some Figma runtimes, so guard each check.
  try {
    if (figma['createNodeFromSvgAsync'] && typeof figma['createNodeFromSvgAsync'] === 'function') {
      svgNode = await figma.createNodeFromSvgAsync(processedSource);
    }
  } catch (_e) {}
  if (!svgNode) {
    try {
      if (figma['createNodeFromSvg'] && typeof figma['createNodeFromSvg'] === 'function') {
        svgNode = figma.createNodeFromSvg(processedSource);
      }
    } catch (_e) {}
  }
  if (!svgNode) return null;

  try {
    try { svgNode.resize(w, h); } catch (_e) {}
    const col = parseColor(tn.styles && tn.styles.color);
    if (sourceUsesCurrentColor && col && col.a > 0 && 'findAll' in svgNode) {
      try {
        const vectors = svgNode.findAll(function (n) { return n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION'; });
        vectors.forEach(function (v) {
          if ('fills' in v && Array.isArray(v.fills)) {
            v.fills = v.fills.map(function (f) {
              if (f && f.type === 'SOLID' && isSentinelColor(f.color)) {
                return { type: 'SOLID', color: { r: col.r, g: col.g, b: col.b }, opacity: col.a };
              }
              return f;
            });
          }
          if ('strokes' in v && Array.isArray(v.strokes)) {
            v.strokes = v.strokes.map(function (s) {
              if (s && s.type === 'SOLID' && isSentinelColor(s.color)) {
                return { type: 'SOLID', color: { r: col.r, g: col.g, b: col.b }, opacity: col.a };
              }
              return s;
            });
          }
        });
      } catch (_e) {}
    }
    return svgNode;
  } catch (e) {
    console.warn('[WebSnap] SVG render failed:', e && e.message);
    return null;
  }
}

function applyTransform(node, tn) {
  const t = tn.styles && tn.styles.transform;
  if (!t || t === 'none' || !('rotation' in node)) return;
  // rotate(Xdeg | Xrad | Xturn)
  const rotMatch = t.match(/\brotate\s*\(\s*([+-]?[\d.]+)(deg|rad|turn|grad)?\s*\)/);
  if (rotMatch) {
    let deg = parseFloat(rotMatch[1]);
    const unit = rotMatch[2] || 'deg';
    if (unit === 'rad') deg = deg * 180 / Math.PI;
    else if (unit === 'turn') deg = deg * 360;
    else if (unit === 'grad') deg = deg * 0.9;
    // CSS rotation is clockwise positive; Figma rotation is counterclockwise positive
    try { node.rotation = -deg; } catch (_e) {}
    return;
  }
  // matrix(a, b, c, d, e, f) — extract rotation
  const matMatch = t.match(/\bmatrix\s*\(([^)]+)\)/);
  if (matMatch) {
    const m = matMatch[1].split(',').map(function (s) { return parseFloat(s.trim()); });
    if (m.length >= 4 && !isNaN(m[0]) && !isNaN(m[1])) {
      const angle = Math.atan2(m[1], m[0]) * 180 / Math.PI;
      if (Math.abs(angle) > 0.01) {
        try { node.rotation = -angle; } catch (_e) {}
      }
    }
  }
}

function applyFilter(node, tn) {
  const f = tn.styles && tn.styles.filter;
  if (!f || f === 'none' || !('effects' in node)) return;
  const existing = Array.isArray(node.effects) ? node.effects.slice() : [];

  // drop-shadow(...) — CSS accepts the color and the three px values in EITHER order
  // (`Xpx Ypx blur color` from the spec, or `color Xpx Ypx blur` which is what Chrome's
  // computed style returns). Parse each drop-shadow(...) chunk, pull the color and the
  // three px values out of the inside, and don't rely on a fixed order.
  // Match the contents of drop-shadow(...) including ONE level of nested parens
  // (for the rgba(...) color). Without the nested handling, `rgba(150,255,70,.5)` would
  // close the drop-shadow match early on its first `)`.
  const dropChunk = /drop-shadow\s*\(((?:[^()]+|\([^)]*\))*)\)/g;
  let m;
  while ((m = dropChunk.exec(f)) !== null) {
    const inside = m[1];
    // Try each color-shaped token; parseColor rejects unit names ("px"), so the loop
    // correctly skips them and lands on the real color.
    const colTokens = inside.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|\b[a-zA-Z]+\b/g) || [];
    let col = null, colStr = null;
    for (let i = 0; i < colTokens.length; i++) {
      const c = parseColor(colTokens[i]);
      if (c) { col = c; colStr = colTokens[i]; break; }
    }
    if (!col) continue;
    // Remove the color token before reading lengths — otherwise rgba's internal numbers
    // get counted as offsets/radius. Also use a plain-number regex (no "px" required) so
    // a zero written as `0` instead of `0px` is honored (CSS allows that).
    const lengthSrc = colStr ? inside.replace(colStr, ' ') : inside;
    const numMatches = lengthSrc.match(/-?\d*\.?\d+/g) || [];
    if (numMatches.length < 3) continue;
    const px = numMatches.slice(0, 3).map(function (s) { return parseFloat(s); });
    existing.push({
      type: 'DROP_SHADOW',
      color: { r: col.r, g: col.g, b: col.b, a: col.a },
      offset: { x: px[0], y: px[1] },
      radius: px[2],
      spread: 0,
      visible: true,
      blendMode: 'NORMAL'
    });
  }
  // blur(Xpx)
  const blurMatch = f.match(/\bblur\s*\(([\d.]+)px?\)/i);
  if (blurMatch) {
    existing.push({
      type: 'LAYER_BLUR',
      radius: parseFloat(blurMatch[1]),
      visible: true
    });
  }
  // backdrop-filter: backdrop-blur is on the same property in modern CSS sometimes
  if (existing.length) {
    try { node.effects = existing; } catch (_e) {}
  }
}

// ---------- Text ----------

// Resolve + load a usable Figma font for a given CSS family list and weight/italic.
async function resolveFont(cssFamily, weight, italic) {
  const families = pickFontFamilies(cssFamily);
  const style = makeStyleString(weight, italic);
  for (let i = 0; i < families.length; i++) {
    const candidate = { family: families[i], style };
    if (await loadFontSafe(candidate)) return candidate;
  }
  for (let i = 0; i < families.length; i++) {
    const candidate = { family: families[i], style: 'Regular' };
    if (await loadFontSafe(candidate)) return candidate;
  }
  const interStyle = { family: 'Inter', style };
  if (await loadFontSafe(interStyle)) return interStyle;
  await loadFontSafe(FALLBACK_FONT);
  return FALLBACK_FONT;
}

async function createTextNode(tn) {
  const t = figma.createText();
  const weight = mapWeight(tn.text.style.fontWeight);
  const italic = tn.text.style.fontStyle === 'italic';
  const fontUsed = await resolveFont(tn.text.style.fontFamily, weight, italic);
  t.fontName = fontUsed;
  const chars = collapseWhitespace(tn.text.content, tn.text.style.whiteSpace);
  if (!chars) {
    // Empty after whitespace collapse — drop this text node
    try {
      t.remove();
    } catch (_e) {}
    return null;
  }
  t.characters = chars;

  // Font size
  if (tn.text.style.fontSize) {
    t.fontSize = clamp(tn.text.style.fontSize, 1, 800);
  }

  // Color — with gradient-text support.
  // Gradient text: element has background:gradient + background-clip:text + color:transparent.
  const bgClip = (tn.styles && (tn.styles.backgroundClip || tn.styles.webkitBackgroundClip)) || '';
  const isGradientText = bgClip.indexOf('text') >= 0 && tn.styles && tn.styles.backgroundGradient;
  if (isGradientText) {
    const grad = parseCSSGradient(tn.styles.backgroundGradient);
    if (grad) {
      try { t.fills = [grad]; } catch (_e) {}
    }
    // (gradient text overrides per-run styling)
  } else {
    const color = parseColor(tn.text.style.color);
    if (color) t.fills = [{
      type: 'SOLID',
      color: {
        r: color.r,
        g: color.g,
        b: color.b
      },
      opacity: color.a
    }];
  }

  // text-shadow → DROP_SHADOW effect on the text node
  const ts = tn.styles && tn.styles.textShadow;
  if (ts && ts !== 'none' && 'effects' in t) {
    const shadows = parseBoxShadows(ts); // same "x y blur color" grammar
    if (shadows.length) {
      try {
        t.effects = shadows.map(p => ({
          type: 'DROP_SHADOW',
          color: { r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a },
          offset: { x: p.x, y: p.y },
          radius: p.blur,
          spread: 0,
          visible: true,
          blendMode: 'NORMAL'
        }));
      } catch (_e) {}
    }
  }

  // Line height
  const lh = parseLineHeight(tn.text.style.lineHeight, tn.text.style.fontSize);
  if (lh) t.lineHeight = lh;

  // Letter spacing
  const ls = parseLetterSpacing(tn.text.style.letterSpacing, tn.text.style.fontSize);
  if (ls) t.letterSpacing = ls;

  // Text align
  if (tn.text.style.textAlign) {
    const map = {
      left: 'LEFT',
      right: 'RIGHT',
      center: 'CENTER',
      justify: 'JUSTIFIED',
      start: 'LEFT',
      end: 'RIGHT'
    };
    if (map[tn.text.style.textAlign]) t.textAlignHorizontal = map[tn.text.style.textAlign];
  }

  // Text transform
  const tt = tn.text.style.textTransform;
  if (tt === 'uppercase') t.textCase = 'UPPER';else if (tt === 'lowercase') t.textCase = 'LOWER';else if (tt === 'capitalize') t.textCase = 'TITLE';

  // Text decoration
  const td = tn.text.style.textDecoration || '';
  if (td.includes('underline')) t.textDecoration = 'UNDERLINE';else if (td.includes('line-through')) t.textDecoration = 'STRIKETHROUGH';

  // Sizing — match captured box dimensions, but never let font substitution force a wrap.
  const nowrap = tn.text.style.whiteSpace === 'nowrap';
  try {
    const targetW = Math.max(1, Math.round(tn.rect.w));
    const targetH = Math.max(1, Math.round(tn.rect.h));
    const fs = parseFloat(tn.text.style.fontSize) || 16;
    const content = chars;

    // Was the original text a single line? Two lines start around 2.4x the font size
    // (line-height 1.2), so 2.0x cleanly separates one line from many. A one-line box
    // must never wrap — if the substituted font is wider, Figma breaks it mid-word
    // ("Breathe" -> "Brea/the"). Multi-line text keeps a fixed width so wrapping survives.
    const singleLine = targetH <= fs * 2.0;

    // Safety net: even if height detection is off, a too-narrow box for the longest word
    // is a broken wrap.
    const longestWord = content.split(/\s+/).reduce(function (m, w) { return w.length > m ? w.length : m; }, 0);
    const looksBroken = longestWord * fs * 0.6 > targetW && longestWord > 3;

    if (nowrap || singleLine || looksBroken) {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      // Re-anchor center/right text so it doesn't drift after the box resizes to content.
      const align = tn.text.style.textAlign;
      if (align === 'center' || align === 'right' || align === 'end') {
        const newW = Math.max(1, Math.round(t.width));
        const delta = (align === 'center') ? (targetW - newW) / 2 : (targetW - newW);
        if (isFinite(delta) && Math.abs(delta) >= 1) tn.rect.x = Math.round(tn.rect.x + delta);
      }
    } else {
      // Multi-line: fix the width and let height grow. Overflow is visible/fixable;
      // clipping would silently lose text.
      t.textAutoResize = 'HEIGHT';
      t.resize(targetW, Math.max(1, t.height));
    }
  } catch (_e) {}

  // Per-range styling for mixed inline formatting (bold/colored word in a sentence).
  // Skip for gradient text (the gradient fill covers the whole node).
  if (!isGradientText && tn.text.runs && tn.text.runs.length > 1) {
    await applyTextRuns(t, tn.text.runs, fontUsed);
  }
  return t;
}

async function applyTextRuns(t, runs, baseFont) {
  const full = t.characters;
  if (!full) return;
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const runText = collapseWhitespace(run.text, run.style && run.style.whiteSpace);
    if (!runText) continue;
    const idx = full.indexOf(runText, cursor);
    if (idx < 0) continue;
    const start = idx;
    const end = idx + runText.length;
    cursor = end;
    const st = run.style || {};
    // Font (weight/style/family) for this range
    try {
      const weight = mapWeight(st.fontWeight);
      const italic = st.fontStyle === 'italic';
      const font = await resolveFont(st.fontFamily, weight, italic);
      t.setRangeFontName(start, end, font);
    } catch (_e) {}
    // Font size
    if (st.fontSize) {
      try { t.setRangeFontSize(start, end, clamp(st.fontSize, 1, 800)); } catch (_e) {}
    }
    // Color
    const col = parseColor(st.color);
    if (col) {
      try { t.setRangeFills(start, end, [{ type: 'SOLID', color: { r: col.r, g: col.g, b: col.b }, opacity: col.a }]); } catch (_e) {}
    }
    // Decoration
    const td = st.textDecoration || '';
    try {
      if (td.indexOf('underline') >= 0) t.setRangeTextDecoration(start, end, 'UNDERLINE');
      else if (td.indexOf('line-through') >= 0) t.setRangeTextDecoration(start, end, 'STRIKETHROUGH');
    } catch (_e) {}
    // Letter spacing
    const ls = parseLetterSpacing(st.letterSpacing, st.fontSize);
    if (ls) { try { t.setRangeLetterSpacing(start, end, ls); } catch (_e) {} }
  }
}
function collapseWhitespace(text, whiteSpace) {
  if (!text) return '';
  if (whiteSpace && whiteSpace.includes('pre')) return text;
  // Preserve newlines (innerText translates <br> into \n) as real line breaks. Collapse
  // every other whitespace run to a single space, strip spaces around \n so a line break
  // doesn't carry leading/trailing indent, cap consecutive blanks at two, then trim ends.
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}
function pickFontFamily(cssFamily) {
  const list = pickFontFamilies(cssFamily);
  return list[0] || 'Inter';
}
function pickFontFamilies(cssFamily) {
  if (!cssFamily) return ['Inter'];
  const SYSTEM_KEYS = ['system-ui', '-apple-system', 'blinkmacsystemfont', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded'];
  const SYSTEM_MAP = { 'sans-serif': 'Inter', 'serif': 'Times New Roman', 'monospace': 'Roboto Mono' };
  const out = [];
  const seen = new Set();
  cssFamily.split(',').forEach(function (s) {
    const cleaned = s.trim().replace(/^["']|["']$/g, '');
    if (!cleaned) return;
    const low = cleaned.toLowerCase();
    if (SYSTEM_KEYS.indexOf(low) >= 0) {
      const mapped = SYSTEM_MAP[low];
      if (mapped && !seen.has(mapped)) { seen.add(mapped); out.push(mapped); }
      return;
    }
    if (!seen.has(cleaned)) { seen.add(cleaned); out.push(cleaned); }
  });
  if (!out.length || !seen.has('Inter')) out.push('Inter');
  return out;
}
function mapWeight(w) {
  if (typeof w === 'string') {
    const map = {
      normal: 400,
      bold: 700,
      lighter: 300,
      bolder: 700
    };
    if (map[w]) return map[w];
    const n = parseInt(w, 10);
    if (!isNaN(n)) return n;
    return 400;
  }
  return w || 400;
}
function makeStyleString(weight, italic) {
  const w = weight || 400;
  const weightName = w <= 100 ? 'Thin' : w <= 200 ? 'Extra Light' : w <= 300 ? 'Light' : w <= 400 ? 'Regular' : w <= 500 ? 'Medium' : w <= 600 ? 'Semi Bold' : w <= 700 ? 'Bold' : w <= 800 ? 'Extra Bold' : 'Black';
  if (italic) {
    if (weightName === 'Regular') return 'Italic';
    return weightName + ' Italic';
  }
  return weightName;
}
const missingFonts = new Set();
async function loadFontSafe(font) {
  const key = font.family + '|' + font.style;
  if (loadedFonts.has(key)) return true;
  if (missingFonts.has(key)) return false;
  try {
    await figma.loadFontAsync(font);
    loadedFonts.add(key);
    return true;
  } catch (_e) {
    missingFonts.add(key);
    return false;
  }
}
async function preloadFonts(fonts) {
  await Promise.all(fonts.map(f => loadFontSafe(f)));
}
function collectFonts(tn) {
  let out = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
  let seen = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : new Set();
  if (!tn) return out;
  const addStyle = (cssFamily, fw, fst) => {
    const family = pickFontFamily(cssFamily);
    const weight = mapWeight(fw);
    const italic = fst === 'italic';
    const style = makeStyleString(weight, italic);
    const key = family + '|' + style;
    if (!seen.has(key)) { seen.add(key); out.push({ family, style }); }
  };
  if (tn.text && tn.text.style) {
    addStyle(tn.text.style.fontFamily, tn.text.style.fontWeight, tn.text.style.fontStyle);
    // Also preload fonts used by inline runs
    if (Array.isArray(tn.text.runs)) {
      tn.text.runs.forEach(r => {
        if (r && r.style) addStyle(r.style.fontFamily, r.style.fontWeight, r.style.fontStyle);
      });
    }
  }
  if (tn.children) tn.children.forEach(c => collectFonts(c, out, seen));
  return out;
}
function parseLineHeight(val, fontSize) {
  if (!val || val === 'normal') return null;
  if (typeof val === 'string') {
    if (val.endsWith('px')) return { value: parseFloat(val), unit: 'PIXELS' };
    if (val.endsWith('%')) return { value: parseFloat(val), unit: 'PERCENT' };
    if (val.endsWith('em') && fontSize) return { value: parseFloat(val) * fontSize, unit: 'PIXELS' };
    if (val.endsWith('rem') && fontSize) return { value: parseFloat(val) * 16, unit: 'PIXELS' };
  }
  // Unitless number — treat as multiplier of font size
  const num = parseFloat(val);
  if (!isNaN(num) && fontSize) {
    return { value: num * fontSize, unit: 'PIXELS' };
  }
  return null;
}
function parseLetterSpacing(val, fontSize) {
  if (!val || val === 'normal') return null;
  if (typeof val === 'string') {
    if (val.endsWith('px')) return { value: parseFloat(val), unit: 'PIXELS' };
    if (val.endsWith('em') && fontSize) return { value: parseFloat(val) * fontSize, unit: 'PIXELS' };
    if (val.endsWith('rem') && fontSize) return { value: parseFloat(val) * 16, unit: 'PIXELS' };
    if (val.endsWith('%')) return { value: parseFloat(val), unit: 'PERCENT' };
  }
  if (typeof val === 'number' && !isNaN(val) && val !== 0) {
    return { value: val, unit: 'PIXELS' };
  }
  return null;
}

// ---------- Image ----------

async function createImageRect(tn, ctx) {
  const r = figma.createRectangle();
  const w = Math.max(1, Math.round(tn.rect.w));
  const h = Math.max(1, Math.round(tn.rect.h));
  r.resize(w, h);
  // CSS object-fit → Figma scaleMode
  const objFit = (tn.styles && tn.styles.objectFit) || '';
  let scaleMode = 'FILL';
  if (objFit === 'contain') scaleMode = 'FIT';
  else if (objFit === 'none') scaleMode = 'CROP';
  else if (objFit === 'scale-down') scaleMode = 'FIT';
  // 'cover' is FILL (default)
  const fill = await buildImageFill(tn.image.id, ctx, scaleMode);
  if (fill) {
    r.fills = [fill];
  } else {
    r.fills = [{
      type: 'SOLID',
      color: {
        r: 0.9,
        g: 0.9,
        b: 0.9
      }
    }];
  }
  applyCornerRadius(r, tn);
  applyStroke(r, tn);
  applyEffects(r, tn, ctx);
  return r;
}
async function buildImageFill(assetId, ctx, scaleMode) {
  const dataUri = ctx.assets[assetId];
  if (!dataUri) return null;
  try {
    let hash = imageHashCache.get(dataUri);
    if (!hash) {
      const bytes = dataUriToBytes(dataUri);
      if (!bytes) return null;
      const image = figma.createImage(bytes);
      hash = image.hash;
      imageHashCache.set(dataUri, hash);
    }
    return {
      type: 'IMAGE',
      scaleMode: scaleMode || 'FILL',
      imageHash: hash
    };
  } catch (e) {
    console.warn('[WebSnap] image fill failed', e);
    return null;
  }
}
function dataUriToBytes(uri) {
  if (!uri || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (meta.includes('base64')) {
    return base64ToBytes(data);
  }
  // URL-encoded text (e.g. svg+xml) — encode UTF-8 to preserve multibyte chars
  const txt = decodeURIComponent(data);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(txt);
  }
  // Manual UTF-8 encode fallback
  const out = [];
  for (let i = 0; i < txt.length; i++) {
    let c = txt.charCodeAt(i);
    if (c < 0x80) out.push(c);else if (c < 0x800) {
      out.push(0xc0 | c >> 6);
      out.push(0x80 | c & 0x3f);
    } else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | c >> 12);
      out.push(0x80 | c >> 6 & 0x3f);
      out.push(0x80 | c & 0x3f);
    } else {
      i++;
      c = 0x10000 + ((c & 0x3ff) << 10 | txt.charCodeAt(i) & 0x3ff);
      out.push(0xf0 | c >> 18);
      out.push(0x80 | c >> 12 & 0x3f);
      out.push(0x80 | c >> 6 & 0x3f);
      out.push(0x80 | c & 0x3f);
    }
  }
  return new Uint8Array(out);
}
function base64ToBytes(b64) {
  // figma plugin context has atob
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

// ---------- Visual styles ----------

function applyVisualStyles(node, tn, ctx) {
  const fills = [];

  // Background color
  const bgColor = parseColor(tn.styles.backgroundColor);
  if (bgColor && bgColor.a > 0) {
    fills.push({
      type: 'SOLID',
      color: {
        r: bgColor.r,
        g: bgColor.g,
        b: bgColor.b
      },
      opacity: bgColor.a
    });
  }

  // Background image asset
  if (tn.styles.backgroundAsset && tn.styles.backgroundAsset.id && ctx.options.images !== false) {
    const dataUri = ctx.assets[tn.styles.backgroundAsset.id];
    if (dataUri) {
      try {
        let hash = imageHashCache.get(dataUri);
        if (!hash) {
          const bytes = dataUriToBytes(dataUri);
          if (bytes) {
            const image = figma.createImage(bytes);
            hash = image.hash;
            imageHashCache.set(dataUri, hash);
          }
        }
        if (hash) {
          // Tile assets (baked from repeating-gradient / small-tile backgrounds in the
          // capture) must use TILE scale mode at their natural pixel size — otherwise
          // a 26x26 grid line stretches to fill the whole card and the pattern is lost.
          const asset = tn.styles.backgroundAsset;
          let scaleMode = mapBgScale(tn.styles.backgroundSize);
          let imageTransform = undefined;
          if (asset.tile) {
            scaleMode = 'TILE';
          }
          const fill = {
            type: 'IMAGE',
            scaleMode: scaleMode,
            imageHash: hash
          };
          if (asset.tile && asset.width) {
            // scalingFactor of 1 means "render at 1px-per-image-pixel" — combined with
            // TILE this gives an actual repeating tile at the captured pixel size.
            fill.scalingFactor = 1;
          }
          fills.push(fill);
        }
      } catch (e) {}
    }
  }

  // Gradient(s) — multi-layer support; CSS first layer = on top, Figma last fill = on top
  if (ctx.options.effects) {
    const gradLayers = tn.styles.backgroundGradients ||
      (tn.styles.backgroundGradient ? [tn.styles.backgroundGradient] : null);
    if (gradLayers && gradLayers.length) {
      // Push in reverse CSS order so gradLayers[0] (CSS top) ends up last (Figma top)
      for (let _gi = gradLayers.length - 1; _gi >= 0; _gi--) {
        const grad = parseCSSGradient(gradLayers[_gi]);
        if (grad) fills.push(grad);
      }
    }
  }
  if ('fills' in node) {
    node.fills = fills;
  }
  applyCornerRadius(node, tn);
  applyStroke(node, tn);
  if (ctx.options.effects) {
    applyEffects(node, tn, ctx);
  }

  // Opacity — treat 0 as a scroll-reveal initial state and render at full visibility
  if (tn.styles.opacity) {
    const o = parseFloat(tn.styles.opacity);
    // Skip opacity 0 entirely (scroll-reveal initial state) and render visible
    if (!isNaN(o) && o > 0 && o < 1 && 'opacity' in node) {
      node.opacity = clamp(o, 0.01, 1);
    }
  }

  // mix-blend-mode → Figma blendMode
  applyBlendMode(node, tn);

  // Clip content for overflow:hidden / clip / scroll
  const ovx = tn.styles.overflowX || tn.styles.overflow || '';
  const ovy = tn.styles.overflowY || tn.styles.overflow || '';
  if ('clipsContent' in node && (ovx === 'hidden' || ovx === 'clip' || ovx === 'scroll' || ovy === 'hidden' || ovy === 'clip' || ovy === 'scroll')) {
    try {
      node.clipsContent = true;
    } catch (_e) {}
  } else if ('clipsContent' in node) {
    try {
      node.clipsContent = false;
    } catch (_e) {}
  }
}
function mapBgScale(size) {
  if (!size) return 'FILL';
  if (size.includes('contain')) return 'FIT';
  if (size.includes('cover')) return 'FILL';
  // Explicit pixel size on a non-tile asset — Figma's TILE scale mode crops at the image's
  // natural size, so fall back to FILL when we don't have an explicit tile flag.
  return 'FILL';
}
function applyCornerRadius(node, tn) {
  if (!('cornerRadius' in node) && !('topLeftRadius' in node)) return;
  const s = tn.styles;
  const tl = parseFloat(s.borderTopLeftRadius) || 0;
  const tr = parseFloat(s.borderTopRightRadius) || 0;
  const bl = parseFloat(s.borderBottomLeftRadius) || 0;
  const br = parseFloat(s.borderBottomRightRadius) || 0;
  if (!tl && !tr && !bl && !br) return;
  if (tl === tr && tr === bl && bl === br) {
    try {
      node.cornerRadius = tl;
    } catch (_e) {}
  } else {
    try {
      node.topLeftRadius = tl;
      node.topRightRadius = tr;
      node.bottomLeftRadius = bl;
      node.bottomRightRadius = br;
    } catch (_e) {}
  }
}
function applyStroke(node, tn) {
  if (!('strokes' in node)) return;
  const s = tn.styles;
  // Only render strokes for sides where border-style is visible (not none/hidden)
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const visible = sides.map(side => {
    const style = s['border' + side + 'Style'] || 'solid';
    const width = parseFloat(s['border' + side + 'Width']) || 0;
    if (style === 'none' || style === 'hidden') return {
      width: 0,
      color: null,
      style
    };
    return {
      width,
      color: parseColor(s['border' + side + 'Color']),
      style
    };
  });
  let maxW = Math.max(...visible.map(v => v.width));
  let firstColor = visible.map(v => v.color).find(c => c && c.a > 0);

  // Per-side borders: if only SOME sides have a border (e.g. a bottom-only divider),
  // use Figma's individual stroke weights so we don't draw a full box outline.
  const sidesWithBorder = visible.filter(v => v.width > 0 && v.color && v.color.a > 0);
  const allFourEqual = sidesWithBorder.length === 4 &&
    visible.every(v => v.width === visible[0].width);
  if (sidesWithBorder.length > 0 && sidesWithBorder.length < 4 && firstColor &&
      'strokeTopWeight' in node) {
    try {
      node.strokes = [{ type: 'SOLID', color: { r: firstColor.r, g: firstColor.g, b: firstColor.b }, opacity: firstColor.a }];
      node.strokeAlign = 'INSIDE';
      node.strokeTopWeight = visible[0].width || 0;
      node.strokeRightWeight = visible[1].width || 0;
      node.strokeBottomWeight = visible[2].width || 0;
      node.strokeLeftWeight = visible[3].width || 0;
      return;
    } catch (_e) {}
  }

  // Fall back to CSS outline if no border was found
  if ((maxW <= 0 || !firstColor) && s.outlineStyle && s.outlineStyle !== 'none' && s.outlineStyle !== 'hidden') {
    const ow = parseFloat(s.outlineWidth) || 0;
    const oc = parseColor(s.outlineColor);
    if (ow > 0 && oc && oc.a > 0) {
      maxW = ow;
      firstColor = oc;
    }
  }

  if (maxW <= 0) return;
  if (!firstColor) return;
  try {
    node.strokes = [{
      type: 'SOLID',
      color: {
        r: firstColor.r,
        g: firstColor.g,
        b: firstColor.b
      },
      opacity: firstColor.a
    }];
    node.strokeWeight = maxW;
    node.strokeAlign = 'INSIDE';
    // Dashed / dotted approximation
    const firstWithWidth = visible.find(function (v) {
      return v.width > 0;
    });
    const firstStyle = firstWithWidth ? firstWithWidth.style : null;
    if (firstStyle === 'dashed' && 'dashPattern' in node) {
      try {
        node.dashPattern = [Math.max(2, maxW * 2), Math.max(2, maxW)];
      } catch (_e) {}
    } else if (firstStyle === 'dotted' && 'dashPattern' in node) {
      try {
        node.dashPattern = [maxW, maxW];
      } catch (_e) {}
    }
  } catch (_e) {}
}
function applyEffects(node, tn, ctx) {
  if (!('effects' in node)) return;
  const effects = [];
  const sh = tn.styles.boxShadow;
  if (sh && sh !== 'none') {
    const parsed = parseBoxShadows(sh);
    parsed.forEach(p => {
      effects.push({
        type: p.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: {
          r: p.color.r,
          g: p.color.g,
          b: p.color.b,
          a: p.color.a
        },
        offset: {
          x: p.x,
          y: p.y
        },
        radius: p.blur,
        spread: p.spread,
        visible: true,
        blendMode: 'NORMAL'
      });
    });
  }

  // backdrop-filter: blur(...) → Figma BACKGROUND_BLUR (glassmorphism)
  const bf = tn.styles.backdropFilter || tn.styles.webkitBackdropFilter;
  if (bf && bf !== 'none') {
    const m = bf.match(/blur\s*\(([\d.]+)px?\)/i);
    if (m) {
      effects.push({ type: 'BACKGROUND_BLUR', radius: parseFloat(m[1]), visible: true });
    }
  }

  if (effects.length) {
    try {
      node.effects = effects;
    } catch (_e) {}
  }
}

function applyBlendMode(node, tn) {
  if (!('blendMode' in node)) return;
  const bm = tn.styles && tn.styles.mixBlendMode;
  if (!bm || bm === 'normal') return;
  const map = {
    'multiply': 'MULTIPLY', 'screen': 'SCREEN', 'overlay': 'OVERLAY',
    'darken': 'DARKEN', 'lighten': 'LIGHTEN',
    'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN',
    'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
    'difference': 'DIFFERENCE', 'exclusion': 'EXCLUSION',
    'hue': 'HUE', 'saturation': 'SATURATION', 'color': 'COLOR', 'luminosity': 'LUMINOSITY'
  };
  if (map[bm]) {
    try { node.blendMode = map[bm]; } catch (_e) {}
  }
}

// ---------- Auto layout ----------

// ---------- Tree simplification ----------

const SEMANTIC_TAGS = {
  header: 1, footer: 1, nav: 1, main: 1, section: 1, article: 1, aside: 1,
  form: 1, ul: 1, ol: 1, li: 1, figure: 1, figcaption: 1, table: 1, h1: 1,
  h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, button: 1, a: 1
};

function nodeHasVisualStyle(tn) {
  const s = tn.styles || {};
  const bg = parseColor(s.backgroundColor);
  if (bg && bg.a > 0) return true;
  if (s.backgroundAsset || s.backgroundGradient || (s.backgroundGradients && s.backgroundGradients.length)) return true;
  if (s.boxShadow && s.boxShadow !== 'none') return true;
  if (s.backdropFilter && s.backdropFilter !== 'none') return true;
  if (s.filter && s.filter !== 'none') return true;
  if (s.mixBlendMode && s.mixBlendMode !== 'normal') return true;
  const anyBorder = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
    .some(k => (parseFloat(s[k]) || 0) > 0 && (s[(k.replace('Width', 'Style'))] || 'none') !== 'none');
  if (anyBorder) return true;
  if ((parseFloat(s.outlineWidth) || 0) > 0 && (s.outlineStyle || 'none') !== 'none') return true;
  const anyRadius = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
    .some(k => (parseFloat(s[k]) || 0) > 0);
  if (anyRadius) return true;
  const o = parseFloat(s.opacity);
  if (!isNaN(o) && o > 0 && o < 1) return true;
  if (s.transform && s.transform !== 'none') return true;
  return false;
}

function isFlattenableWrapper(tn) {
  if (!tn || !tn.children || !tn.children.length) return false;
  const tag = (tn.tag || '').toLowerCase();
  if (SEMANTIC_TAGS[tag]) return false;          // keep landmarks/headings/links
  if (tn.text && tn.text.content) return false;  // has its own text
  if (tn.image || tn.svg) return false;          // is media
  if (tn.ariaLabel || tn.role) return false;     // has semantic intent
  // NOTE: cleanup only runs in pixel-perfect mode (auto-layout off), where flex/grid
  // containers aren't used for layout — children carry absolute coords — so a style-less
  // flex wrapper is safe to flatten. We do NOT exclude flex/grid here.
  // Keep anything with a clip (overflow hidden) — it visually masks children
  const ov = (tn.styles && (tn.styles.overflow || tn.styles.overflowX || tn.styles.overflowY)) || '';
  if (ov === 'hidden' || ov === 'clip' || ov === 'scroll') return false;
  // Keep positioned wrappers that move children out of flow context (fixed/sticky)
  const pos = (tn.styles && tn.styles.position) || '';
  if (pos === 'fixed' || pos === 'sticky') return false;
  if (nodeHasVisualStyle(tn)) return false;       // has paint worth keeping
  // Keep wrappers whose only "style" is padding — flattening them would silently lose
  // the spacing they introduce around children (a common pattern: <section class="wrap"
  // style="padding:32px"><Card/></section>). nodeHasVisualStyle ignores padding because
  // padding has no visual paint, but it's structurally meaningful for AL.
  const s = tn.styles || {};
  const padSides = ['paddingTop','paddingRight','paddingBottom','paddingLeft'];
  for (let i = 0; i < padSides.length; i++) {
    if ((parseFloat(s[padSides[i]]) || 0) >= 4) return false;
  }
  return true;
}

function simplifyNode(tn) {
  if (!tn) return [];
  // Simplify children first (depth-first)
  if (tn.children && tn.children.length) {
    const out = [];
    for (const c of tn.children) {
      const simplified = simplifyNode(c);
      for (const s of simplified) out.push(s);
    }
    tn.children = out;
  }
  // Then decide whether THIS node dissolves into its children
  if (isFlattenableWrapper(tn)) {
    return tn.children;
  }
  return [tn];
}

function countTree(n) {
  if (!n) return 0;
  let c = 1;
  if (n.children) n.children.forEach(k => c += countTree(k));
  return c;
}

function median(arr) {
  if (!arr || !arr.length) return NaN;
  const s = arr.slice().sort(function (a, b) { return a - b; });
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function flexInFlowSorted(tn, horiz) {
  return (tn.children || []).filter(function (c) {
    const p = c && c.styles && c.styles.position;
    return c && c.rect && p !== 'absolute' && p !== 'fixed';
  }).sort(function (a, b) { return horiz ? (a.rect.x - b.rect.x) : (a.rect.y - b.rect.y); });
}

// Derive auto-layout parameters from the captured child geometry (ground truth) rather
// than from CSS gap/justify-content. The captured rects already encode margins, gaps,
// justify-content and flex-grow, so reproducing them with explicit padding + itemSpacing
// is far more faithful. Returns a `feasible` flag: true only when a single itemSpacing +
// one cross-axis alignment reproduces every child within tolerance. Wrapped layouts return
// { wrap: true } and are handled by the CSS path.
function computeFlexGeometry(tn) {
  const s = tn.styles || {};
  const isGrid = s.display === 'grid' || s.display === 'inline-grid';
  const isFlex = s.display === 'flex' || s.display === 'inline-flex';
  let horiz, wrap = false;
  if (isGrid) {
    const g = gridDirectionAndWrap(tn, (tn.children || []).length);
    horiz = g.mode !== 'VERTICAL';
    wrap = g.wrap;
  } else if (isFlex) {
    const dir = s.flexDirection || 'row';
    horiz = !String(dir).startsWith('column');
  } else {
    horiz = false; // block flow stacks vertically
  }
  if ((isFlex || isGrid) && (s.flexWrap === 'wrap' || s.flexWrap === 'wrap-reverse')) wrap = true;
  if (wrap) return { horiz: horiz, wrap: true, feasible: true };

  const kids = flexInFlowSorted(tn, horiz);
  if (!kids.length) {
    return { horiz: horiz, wrap: false, feasible: true, drift: 0, itemSpacing: 0, padS: 0, padE: 0, counterAlign: 'MIN', padCS: 0, padCE: 0 };
  }

  const cS = horiz ? tn.rect.x : tn.rect.y;
  const cE = horiz ? (tn.rect.x + tn.rect.w) : (tn.rect.y + tn.rect.h);
  const xcS = horiz ? tn.rect.y : tn.rect.x;
  const xcE = horiz ? (tn.rect.y + tn.rect.h) : (tn.rect.x + tn.rect.w);
  const pS = function (c) { return horiz ? c.rect.x : c.rect.y; };
  const pE = function (c) { return horiz ? (c.rect.x + c.rect.w) : (c.rect.y + c.rect.h); };
  const xS = function (c) { return horiz ? c.rect.y : c.rect.x; };
  const xE = function (c) { return horiz ? (c.rect.y + c.rect.h) : (c.rect.x + c.rect.w); };
  const sz = function (c) { return pE(c) - pS(c); };
  const xsz = function (c) { return xE(c) - xS(c); };

  // Primary axis: spacing + leading/trailing padding.
  const gaps = [];
  for (let i = 1; i < kids.length; i++) gaps.push(pS(kids[i]) - pE(kids[i - 1]));
  let sp = kids.length >= 2 ? median(gaps) : 0;
  if (isNaN(sp)) sp = 0;
  const itemSpacing = Math.max(0, Math.round(sp));
  const padS = Math.max(0, Math.round(pS(kids[0]) - cS));
  const padE = Math.max(0, Math.round(cE - pE(kids[kids.length - 1])));

  // Cross axis: pick MIN / CENTER / MAX by best fit to the children's positions.
  const leads = kids.map(function (c) { return xS(c) - xcS; });
  const trails = kids.map(function (c) { return xcE - xE(c); });
  const leadMed = median(leads), trailMed = median(trails);
  let leadVar = 0, trailVar = 0, centerErr = 0;
  for (let i = 0; i < kids.length; i++) {
    leadVar += Math.abs(leads[i] - leadMed);
    trailVar += Math.abs(trails[i] - trailMed);
    centerErr += Math.abs(leads[i] - trails[i]);
  }
  let counterAlign = 'MIN', padCS = Math.max(0, Math.round(leadMed)), padCE = 0;
  if (centerErr <= leadVar && centerErr <= trailVar) {
    counterAlign = 'CENTER'; padCS = 0; padCE = 0;
  } else if (trailVar < leadVar) {
    counterAlign = 'MAX'; padCS = 0; padCE = Math.max(0, Math.round(trailMed));
  }

  // Fidelity check: simulate Figma's MIN layout and measure the worst drift.
  const TOL = 2.0;
  let primaryDrift = 0;
  let cur = cS + padS;
  for (let i = 0; i < kids.length; i++) {
    primaryDrift = Math.max(primaryDrift, Math.abs(cur - pS(kids[i])));
    cur += sz(kids[i]) + itemSpacing;
  }
  let crossDrift = 0;
  for (let i = 0; i < kids.length; i++) {
    let want;
    if (counterAlign === 'MIN') want = xcS + padCS;
    else if (counterAlign === 'MAX') want = xcE - padCE - xsz(kids[i]);
    else want = xcS + ((xcE - xcS) - xsz(kids[i])) / 2;
    crossDrift = Math.max(crossDrift, Math.abs(want - xS(kids[i])));
  }
  const drift = Math.max(primaryDrift, crossDrift);
  const feasible = drift <= TOL;

  return {
    horiz: horiz, wrap: false, feasible: feasible, drift: drift,
    itemSpacing: itemSpacing, padS: padS, padE: padE,
    counterAlign: counterAlign, padCS: padCS, padCE: padCE
  };
}

// How far a child may land from its captured position before we refuse auto layout.
// Block matches flex now — real block stacks routinely have small margin variance between
// siblings (margin-top: 40px on one, 20px on another), which used to push drift past the
// old 6px gate and force the whole stack into pixel-perfect Frames with no AL inheritance.
// Clipped scrollers / marquees / wide grid carousels still blow past this and fall back
// to absolute via the flex path.
const FLEX_DRIFT_TOL = 16;
const BLOCK_DRIFT_TOL = 16;

function shouldUseAutoLayout(tn) {
  const d = tn.styles && tn.styles.display || '';
  const isFlex = d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
  const isBlock = d === '' || d === 'block' || d === 'list-item' || d === 'flow-root';
  if (!isFlex && !isBlock) return false;
  const g = computeFlexGeometry(tn);
  if (!g) return false;
  if (g.wrap) return isFlex; // wrapped flex/grid -> CSS path; block never wraps
  if (isFlex) return (g.drift == null) || g.drift <= FLEX_DRIFT_TOL;
  // Block containers: AL covers vertical stacks, but ALSO single-in-flow-child wrappers
  // that carry meaningful CSS padding. The common case is `<section style="padding:72px">`
  // with one `.wrap` child plus absolute decorative pseudos — under the old rule it failed
  // "< 2 in-flow children" and became a plain Frame, dropping all 72px of section padding.
  const inflow = (tn.children || []).filter(function (c) {
    const p = c && c.styles && c.styles.position;
    return c && c.rect && p !== 'absolute' && p !== 'fixed';
  });
  if (inflow.length === 0) return false;
  if (inflow.length === 1) return hasMeaningfulCssPadding(tn);
  return (g.drift != null) && g.drift <= BLOCK_DRIFT_TOL;
}

// True when any CSS padding side is >= 4px — the threshold below which wrapping in AL
// adds no visible value over a plain Frame.
function hasMeaningfulCssPadding(tn) {
  const s = tn.styles || {};
  const sides = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  for (let i = 0; i < sides.length; i++) {
    if ((parseFloat(s[sides[i]]) || 0) >= 4) return true;
  }
  return false;
}

// Return the rounded CSS padding value when it's within tolerance of the geometric
// value (clean numbers); fall back to geometry when CSS and reality disagree.
const PADDING_PREFER_TOL = 4;
function preferCssPadding(tn, geomValue, cssKey) {
  const s = tn.styles || {};
  const cssVal = parseFloat(s[cssKey]);
  if (isNaN(cssVal)) return geomValue;
  if (Math.abs(cssVal - geomValue) <= PADDING_PREFER_TOL) return Math.round(cssVal);
  return geomValue;
}

// Same idea for itemSpacing — read CSS gap / row-gap / column-gap, prefer when close.
const GAP_PREFER_TOL = 4;
function preferCssSpacing(tn, geomValue, cssKey) {
  const s = tn.styles || {};
  // Single `gap: 24px` shorthand falls back to either rowGap or columnGap depending on
  // axis — getComputedStyle resolves it into both rowGap and columnGap already.
  let cssVal = parseFloat(s[cssKey]);
  if (isNaN(cssVal)) cssVal = parseFloat(s.gap);
  if (isNaN(cssVal)) return geomValue;
  if (Math.abs(cssVal - geomValue) <= GAP_PREFER_TOL) return Math.round(cssVal);
  return geomValue;
}

function gridDirectionAndWrap(tn, childCount) {
  // Returns { mode: 'HORIZONTAL'|'VERTICAL', wrap: boolean, cols: number }
  const s = tn.styles || {};
  const flow = (s.gridAutoFlow || 'row').toString();
  const colsTemplate = (s.gridTemplateColumns || '').toString().trim();
  const rowsTemplate = (s.gridTemplateRows || '').toString().trim();

  // Count tracks: handle `repeat(N, ...)` shorthand
  function countTracks(template) {
    if (!template || template === 'none') return 0;
    let count = 0;
    const repeatRe = /repeat\s*\(\s*(\d+)\s*,([^)]+)\)/g;
    let workingStr = template;
    let m;
    while ((m = repeatRe.exec(template)) !== null) {
      const n = parseInt(m[1], 10);
      const inner = m[2].trim().split(/\s+/).filter(Boolean).length;
      count += n * inner;
      workingStr = workingStr.replace(m[0], '');
    }
    count += workingStr.trim().split(/\s+/).filter(Boolean).length;
    return count;
  }

  const cols = countTracks(colsTemplate);
  const rows = countTracks(rowsTemplate);
  const isColumnFlow = flow.indexOf('column') >= 0;
  const mode = isColumnFlow ? 'VERTICAL' : 'HORIZONTAL';

  // Wrap if columns > 1 and more children than columns (multi-row grid)
  const wrap = !isColumnFlow && cols > 1 && childCount > cols;
  return { mode, wrap, cols };
}
function applyAutoLayout(frame, tn, ctx, inFlowChildren) {
  try {
    // Capture original size before enabling auto-layout (Figma auto-shrinks to hug children otherwise)
    const origW = frame.width;
    const origH = frame.height;

    // Direction + all spacing come from the captured geometry (ground truth).
    const geo = computeFlexGeometry(tn) || { horiz: false, wrap: false, itemSpacing: 0, padS: 0, padE: 0, counterAlign: 'MIN', padCS: 0, padCE: 0 };
    const horiz = geo.horiz;
    frame.layoutMode = horiz ? 'HORIZONTAL' : 'VERTICAL';

    // Lock the sizing modes FIRST so the frame doesn't hug, then restore size
    frame.primaryAxisSizingMode = 'FIXED';
    frame.counterAxisSizingMode = 'FIXED';
    try {
      frame.resize(Math.max(1, origW), Math.max(1, origH));
    } catch (_e) {}

    if (geo && !geo.wrap) {
      // ---- Geometry-derived layout (preferred) ----
      // Reproduce the real child positions with explicit padding + itemSpacing instead
      // of trusting CSS gap, which misses margin-based spacing and collapses the column.
      // BUT: when CSS padding is within a few pixels of the geometric value, prefer the
      // CSS value so Figma frames show clean 72px / 24px / etc. instead of 71.34px from
      // sub-pixel layout math. Geometry still wins when CSS and reality disagree (e.g.
      // justify-content: center with no padding gives a large geometric padding).
      frame.primaryAxisAlignItems = 'MIN';
      frame.counterAxisAlignItems = geo.counterAlign;
      try { frame.itemSpacing = preferCssSpacing(tn, geo.itemSpacing, geo.horiz ? 'columnGap' : 'rowGap'); } catch (_e) {}
      if (geo.horiz) {
        frame.paddingLeft = preferCssPadding(tn, geo.padS, 'paddingLeft');
        frame.paddingRight = preferCssPadding(tn, geo.padE, 'paddingRight');
        frame.paddingTop = geo.counterAlign === 'MIN' ? preferCssPadding(tn, geo.padCS, 'paddingTop') : 0;
        frame.paddingBottom = geo.counterAlign === 'MAX' ? preferCssPadding(tn, geo.padCE, 'paddingBottom') : 0;
      } else {
        frame.paddingTop = preferCssPadding(tn, geo.padS, 'paddingTop');
        frame.paddingBottom = preferCssPadding(tn, geo.padE, 'paddingBottom');
        frame.paddingLeft = geo.counterAlign === 'MIN' ? preferCssPadding(tn, geo.padCS, 'paddingLeft') : 0;
        frame.paddingRight = geo.counterAlign === 'MAX' ? preferCssPadding(tn, geo.padCE, 'paddingRight') : 0;
      }
    } else {
      // ---- CSS-derived fallback (wrapped / grid-wrap layouts) ----
      const jc = tn.styles.justifyContent || 'flex-start';
      const ai = tn.styles.alignItems || 'stretch';
      const primaryMap = {
        'flex-start': 'MIN', 'start': 'MIN', 'left': 'MIN', 'normal': 'MIN',
        'center': 'CENTER', 'flex-end': 'MAX', 'end': 'MAX', 'right': 'MAX',
        'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN'
      };
      const counterMap = {
        'flex-start': 'MIN', 'start': 'MIN', 'normal': 'MIN', 'center': 'CENTER',
        'flex-end': 'MAX', 'end': 'MAX', 'baseline': 'BASELINE', 'stretch': 'MIN'
      };
      frame.primaryAxisAlignItems = primaryMap[jc] || 'MIN';
      frame.counterAxisAlignItems = counterMap[ai] || 'MIN';

      frame.paddingTop = parseFloat(tn.styles.paddingTop) || 0;
      frame.paddingRight = parseFloat(tn.styles.paddingRight) || 0;
      frame.paddingBottom = parseFloat(tn.styles.paddingBottom) || 0;
      frame.paddingLeft = parseFloat(tn.styles.paddingLeft) || 0;

      const gapStr = String(tn.styles.gap || '').trim();
      let itemSpacing = NaN;
      if (gapStr) {
        const parts = gapStr.split(/\s+/);
        if (parts.length >= 2) {
          const rowGap = parseFloat(parts[0]);
          const colGap = parseFloat(parts[1]);
          itemSpacing = horiz ? colGap : rowGap;
        } else {
          itemSpacing = parseFloat(parts[0]);
        }
      }
      if (isNaN(itemSpacing)) {
        const explicit = horiz ? tn.styles.columnGap : tn.styles.rowGap;
        itemSpacing = parseFloat(explicit);
      }
      if (!isNaN(itemSpacing)) frame.itemSpacing = itemSpacing;

      try { frame.layoutWrap = 'WRAP'; } catch (_e) {}
      const counterGapStr = String(tn.styles.gap || tn.styles.rowGap || '').trim();
      if (counterGapStr) {
        const cp = counterGapStr.split(/\s+/);
        const counterGap = cp.length >= 2 ? (horiz ? parseFloat(cp[0]) : parseFloat(cp[1])) : parseFloat(cp[0]);
        if (!isNaN(counterGap)) {
          try { frame.counterAxisSpacing = counterGap; } catch (_e) {}
        }
      }

      // Per-child flex-grow → layoutGrow, align-self → layoutAlign
      if (Array.isArray(inFlowChildren) && Array.isArray(tn.children)) {
        const inFlowTn = tn.children.filter(function (c) {
          const p = c && c.styles && c.styles.position;
          return p !== 'absolute' && p !== 'fixed';
        });
        for (let i = 0; i < inFlowChildren.length && i < inFlowTn.length; i++) {
          const fn = inFlowChildren[i];
          const ctn = inFlowTn[i];
          if (!fn || !ctn || !ctn.styles) continue;
          const grow = parseFloat(ctn.styles.flexGrow);
          if (!isNaN(grow) && grow > 0) {
            try { fn.layoutGrow = grow; } catch (_e) {}
          }
          const alignSelf = ctn.styles.alignSelf;
          if (alignSelf && alignSelf !== 'auto') {
            const map = { 'stretch': 'STRETCH', 'center': 'CENTER', 'flex-start': 'MIN', 'flex-end': 'MAX', 'start': 'MIN', 'end': 'MAX' };
            if (map[alignSelf]) { try { fn.layoutAlign = map[alignSelf]; } catch (_e) {} }
          }
        }
      }

      if ((ai === 'stretch' || ai === 'normal') && Array.isArray(inFlowChildren)) {
        inFlowChildren.forEach(c => {
          try { c.layoutAlign = 'STRETCH'; } catch (_e) {}
        });
      }
    }

    // Restore size again after all properties are set, in case any reset it
    try {
      frame.resize(Math.max(1, origW), Math.max(1, origH));
    } catch (_e) {}
  } catch (e) {
    console.warn('[WebSnap] auto layout failed:', e && e.message, 'tag=' + tn.tag);
    if (ctx && ctx.stats) ctx.stats.errors++;
  }
}

// ---------- Color parsing ----------

function parseColor(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();
  if (str === 'transparent' || str === 'inherit' || str === 'currentcolor') return null;

  // #hex
  if (str.startsWith('#')) {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: 1
      };
    }
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: parseInt(h.slice(6, 8), 16) / 255
      };
    }
    return null;
  }

  // rgb / rgba
  const rgb = str.match(/^rgba?\s*\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = parseNum(parts[0]) / 255;
      const g = parseNum(parts[1]) / 255;
      const b = parseNum(parts[2]) / 255;
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      return {
        r,
        g,
        b,
        a
      };
    }
  }

  // hsl / hsla
  const hsl = str.match(/^hsla?\s*\(([^)]+)\)/);
  if (hsl) {
    const parts = hsl[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const hue = parseFloat(parts[0]);
      const sat = parseFloat(parts[1]) / 100;
      const lit = parseFloat(parts[2]) / 100;
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const _hslToRgb = hslToRgb(hue, sat, lit),
        r = _hslToRgb.r,
        g = _hslToRgb.g,
        b = _hslToRgb.b;
      return {
        r,
        g,
        b,
        a
      };
    }
  }

  // oklch / oklab — common in Tailwind v4
  const oklch = str.match(/^oklch\s*\(([^)]+)\)/);
  if (oklch) {
    const parts = oklch[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const L = parsePct(parts[0]);
      const C = parseFloat(parts[1]);
      const h = parseFloat(parts[2]);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const _oklchToRgb = oklchToRgb(L, C, h),
        r = _oklchToRgb.r,
        g = _oklchToRgb.g,
        b = _oklchToRgb.b;
      return {
        r: clamp01(r),
        g: clamp01(g),
        b: clamp01(b),
        a
      };
    }
  }
  const oklab = str.match(/^oklab\s*\(([^)]+)\)/);
  if (oklab) {
    const parts = oklab[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const L = parsePct(parts[0]);
      const a_ = parseFloat(parts[1]);
      const b_ = parseFloat(parts[2]);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const _oklabToRgb = oklabToRgb(L, a_, b_),
        r = _oklabToRgb.r,
        g = _oklabToRgb.g,
        b = _oklabToRgb.b;
      return {
        r: clamp01(r),
        g: clamp01(g),
        b: clamp01(b),
        a
      };
    }
  }

  // hwb(H W B [/ A])
  const hwb = str.match(/^hwb\s*\(([^)]+)\)/);
  if (hwb) {
    const parts = hwb[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const h = parseFloat(parts[0]);
      const w = parsePct(parts[1]);
      const bl = parsePct(parts[2]);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const rgb2 = hwbToRgb(h, w, bl);
      return { r: clamp01(rgb2.r), g: clamp01(rgb2.g), b: clamp01(rgb2.b), a };
    }
  }
  // lab(L a b [/ A]) and lch(L C H [/ A]) — convert via OKLab-ish path using CIELAB
  const lab = str.match(/^lab\s*\(([^)]+)\)/);
  if (lab) {
    const parts = lab[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const L = parsePctOr(parts[0], 100);
      const a_ = parseFloat(parts[1]);
      const b_ = parseFloat(parts[2]);
      const al = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const rgb2 = cielabToRgb(L, a_, b_);
      return { r: clamp01(rgb2.r), g: clamp01(rgb2.g), b: clamp01(rgb2.b), a: al };
    }
  }
  const lch = str.match(/^lch\s*\(([^)]+)\)/);
  if (lch) {
    const parts = lch[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const L = parsePctOr(parts[0], 100);
      const C = parseFloat(parts[1]);
      const H = parseFloat(parts[2]);
      const al = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      const rad = H * Math.PI / 180;
      const rgb2 = cielabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
      return { r: clamp01(rgb2.r), g: clamp01(rgb2.g), b: clamp01(rgb2.b), a: al };
    }
  }
  // color(srgb r g b [/ a]) and color(display-p3 ...) — treat values as sRGB (good enough)
  const colorFn = str.match(/^color\s*\(\s*(srgb|srgb-linear|display-p3)\s+([^)]+)\)/);
  if (colorFn) {
    const parts = colorFn[2].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = parsePctOr(parts[0], 1);
      const g = parsePctOr(parts[1], 1);
      const b = parsePctOr(parts[2], 1);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
    }
  }

  // Named colors
  const named = NAMED_COLORS[str];
  if (named) return _objectSpread(_objectSpread({}, named), {}, {
    a: 1
  });
  return null;
}
function parsePctOr(s, scaleMax) {
  // scaleMax = 100 for CIELAB L (0-100 range), 1 for color() channels (0-1 range).
  // A percentage maps to scaleMax; a plain number is taken as-is.
  s = String(s).trim();
  if (s.endsWith('%')) return (parseFloat(s) / 100) * scaleMax;
  return parseFloat(s);
}
function hwbToRgb(h, w, bl) {
  if (w + bl >= 1) { const g = w / (w + bl); return { r: g, g: g, b: g }; }
  const hsl = hslToRgb(h, 1, 0.5);
  const f = (c) => c * (1 - w - bl) + w;
  return { r: f(hsl.r), g: f(hsl.g), b: f(hsl.b) };
}
function cielabToRgb(L, a, b) {
  // CIELAB (D65) → XYZ → linear sRGB → sRGB
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const d = 6 / 29;
  const inv = (t) => t > d ? t * t * t : 3 * d * d * (t - 4 / 29);
  const Xn = 95.047, Yn = 100.0, Zn = 108.883;
  const X = Xn * inv(fx) / 100, Y = Yn * inv(fy) / 100, Z = Zn * inv(fz) / 100;
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let bl2 = X * 0.0557 - Y * 0.2040 + Z * 1.0570;
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(bl2) };
}
function parsePct(s) {
  s = s.trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  return parseFloat(s);
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// oklab → linear sRGB → sRGB (gamma corrected)
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(bl)
  };
}
function oklchToRgb(L, C, h) {
  const rad = h * Math.PI / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  return oklabToRgb(L, a, b);
}
function linearToSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c < 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function parseNum(s) {
  s = s.trim();
  if (s.endsWith('%')) return parseFloat(s) * 2.55;
  return parseFloat(s);
}
function parseAlpha(s) {
  s = s.trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  return parseFloat(s);
}
function hslToRgb(h, s, l) {
  h = (h % 360 + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  return {
    r,
    g,
    b
  };
}
function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
const NAMED_COLORS = {
  black: {
    r: 0,
    g: 0,
    b: 0
  },
  white: {
    r: 1,
    g: 1,
    b: 1
  },
  red: {
    r: 1,
    g: 0,
    b: 0
  },
  green: {
    r: 0,
    g: 0.5,
    b: 0
  },
  blue: {
    r: 0,
    g: 0,
    b: 1
  },
  gray: {
    r: 0.5,
    g: 0.5,
    b: 0.5
  },
  grey: {
    r: 0.5,
    g: 0.5,
    b: 0.5
  },
  silver: {
    r: 0.75,
    g: 0.75,
    b: 0.75
  },
  yellow: {
    r: 1,
    g: 1,
    b: 0
  },
  orange: {
    r: 1,
    g: 0.647,
    b: 0
  },
  purple: {
    r: 0.5,
    g: 0,
    b: 0.5
  },
  cyan: {
    r: 0,
    g: 1,
    b: 1
  },
  magenta: {
    r: 1,
    g: 0,
    b: 1
  },
  pink: {
    r: 1,
    g: 0.753,
    b: 0.796
  },
  brown: {
    r: 0.647,
    g: 0.165,
    b: 0.165
  },
  // Extended common CSS named colors
  navy: { r: 0, g: 0, b: 0.5 },
  teal: { r: 0, g: 0.5, b: 0.5 },
  olive: { r: 0.5, g: 0.5, b: 0 },
  maroon: { r: 0.5, g: 0, b: 0 },
  lime: { r: 0, g: 1, b: 0 },
  aqua: { r: 0, g: 1, b: 1 },
  fuchsia: { r: 1, g: 0, b: 1 },
  gold: { r: 1, g: 0.843, b: 0 },
  coral: { r: 1, g: 0.498, b: 0.314 },
  salmon: { r: 0.98, g: 0.502, b: 0.447 },
  tomato: { r: 1, g: 0.388, b: 0.278 },
  indigo: { r: 0.294, g: 0, b: 0.51 },
  violet: { r: 0.933, g: 0.51, b: 0.933 },
  turquoise: { r: 0.251, g: 0.878, b: 0.816 },
  beige: { r: 0.961, g: 0.961, b: 0.863 },
  ivory: { r: 1, g: 1, b: 0.941 },
  khaki: { r: 0.941, g: 0.902, b: 0.549 },
  crimson: { r: 0.863, g: 0.078, b: 0.235 },
  lavender: { r: 0.902, g: 0.902, b: 0.98 },
  plum: { r: 0.867, g: 0.627, b: 0.867 },
  orchid: { r: 0.855, g: 0.439, b: 0.839 },
  tan: { r: 0.824, g: 0.706, b: 0.549 },
  slategray: { r: 0.439, g: 0.502, b: 0.565 },
  slategrey: { r: 0.439, g: 0.502, b: 0.565 },
  lightgray: { r: 0.827, g: 0.827, b: 0.827 },
  lightgrey: { r: 0.827, g: 0.827, b: 0.827 },
  darkgray: { r: 0.663, g: 0.663, b: 0.663 },
  darkgrey: { r: 0.663, g: 0.663, b: 0.663 },
  dimgray: { r: 0.412, g: 0.412, b: 0.412 },
  whitesmoke: { r: 0.961, g: 0.961, b: 0.961 },
  gainsboro: { r: 0.863, g: 0.863, b: 0.863 },
  rebeccapurple: { r: 0.4, g: 0.2, b: 0.6 },
  skyblue: { r: 0.529, g: 0.808, b: 0.922 },
  steelblue: { r: 0.275, g: 0.51, b: 0.706 },
  royalblue: { r: 0.255, g: 0.412, b: 0.882 },
  midnightblue: { r: 0.098, g: 0.098, b: 0.439 },
  forestgreen: { r: 0.133, g: 0.545, b: 0.133 },
  seagreen: { r: 0.18, g: 0.545, b: 0.341 },
  darkgreen: { r: 0, g: 0.392, b: 0 }
};

// ---------- Shadow parsing ----------

function parseBoxShadows(str) {
  const shadows = [];
  // Split on commas not inside parens
  const parts = splitTopLevel(str, ',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === 'none') continue;
    const inset = /\binset\b/i.test(trimmed);
    const cleaned = trimmed.replace(/\binset\b/i, '').trim();
    // Extract color first (rgb/rgba/hsl/hex/named at start or end)
    let color = null;
    let rest = cleaned;
    const colorMatch = cleaned.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8}|\b[a-z]+\b)/);
    // Pick last token-ish that parses as color
    // Try matching color tokens
    const tokens = cleaned.split(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8}|\b[a-z]+\b|\S+)/).filter(t => t && t.trim());
    for (let i = tokens.length - 1; i >= 0; i--) {
      const c = parseColor(tokens[i]);
      if (c) {
        color = c;
        tokens.splice(i, 1);
        break;
      }
    }
    rest = tokens.join(' ').trim();
    const nums = rest.split(/\s+/).map(n => parseFloat(n)).filter(n => !isNaN(n));
    if (nums.length < 2) continue;
    const _nums = _slicedToArray(nums, 4),
      x = _nums[0],
      y = _nums[1],
      _nums$ = _nums[2],
      blur = _nums$ === void 0 ? 0 : _nums$,
      _nums$2 = _nums[3],
      spread = _nums$2 === void 0 ? 0 : _nums$2;
    if (!color) color = {
      r: 0,
      g: 0,
      b: 0,
      a: 0.5
    };
    shadows.push({
      x,
      y,
      blur,
      spread,
      color,
      inset
    });
  }
  return shadows;
}
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;else if (ch === ')') depth--;
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

// ---------- Gradient parsing ----------

function parseCSSGradient(grad) {
  if (!grad) return null;
  const raw = grad.raw;

  // Radial gradient → Figma GRADIENT_RADIAL
  if (grad.type === 'radial') {
    const parts = splitTopLevel(raw, ',').map(p => p.trim());
    if (parts.length < 2) return null;
    // First token may be shape/size/position (e.g. "circle at center", "85% 77% at 50% 22%")
    let stopsStart = 0;
    if (parts[0] && !parseColorIsStop(parts[0])) stopsStart = 1;
    const stops = parseGradientStops(parts.slice(stopsStart));
    if (stops.length < 2) return null;
    // Default radial transform: centered circle filling the box
    return {
      type: 'GRADIENT_RADIAL',
      gradientTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]],
      gradientStops: stops.map(s => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } }))
    };
  }

  // Conic gradient → Figma GRADIENT_ANGULAR
  if (grad.type === 'conic') {
    const parts = splitTopLevel(raw, ',').map(p => p.trim());
    if (parts.length < 2) return null;
    let stopsStart = 0;
    if (parts[0] && (parts[0].indexOf('from ') >= 0 || parts[0].indexOf('at ') >= 0)) stopsStart = 1;
    const stops = parseGradientStops(parts.slice(stopsStart));
    if (stops.length < 2) return null;
    return {
      type: 'GRADIENT_ANGULAR',
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: stops.map(s => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } }))
    };
  }

  if (grad.type !== 'linear') return null;
  const parts = splitTopLevel(raw, ',').map(p => p.trim());
  if (parts.length < 2) return null;

  // Parse angle
  let angle = 180; // default top-to-bottom in CSS
  let stopsStart = 0;
  const first = parts[0];
  if (/[\d.+-]+\s*(deg|rad|turn|grad)\b/.test(first)) {
    const m = first.match(/([+-]?[\d.]+)\s*(deg|rad|turn|grad)/);
    if (m) {
      const v = parseFloat(m[1]);
      const unit = m[2];
      angle = unit === 'deg' ? v : unit === 'rad' ? v * 180 / Math.PI : unit === 'turn' ? v * 360 : v * 0.9;
      stopsStart = 1;
    }
  } else if (first.startsWith('to ')) {
    const dir = first.slice(3).trim();
    const dirAngle = {
      top: 0,
      'top right': 45,
      right: 90,
      'bottom right': 135,
      bottom: 180,
      'bottom left': 225,
      left: 270,
      'top left': 315,
      'right top': 45,
      'right bottom': 135,
      'left bottom': 225,
      'left top': 315
    };
    if (dirAngle[dir] !== undefined) angle = dirAngle[dir];
    stopsStart = 1;
  }
  const stopTokens = parts.slice(stopsStart);
  const stops = parseGradientStops(stopTokens);
  if (stops.length < 2) return null;

  // Convert CSS angle to Figma gradient transform.
  // CSS 0deg = bottom-to-top. Figma's GRADIENT_LINEAR places start at gradient handle 0, end at handle 1.
  const rad = (angle - 90) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const transform = [[cos, sin, (1 - cos - sin) / 2], [-sin, cos, (1 + sin - cos) / 2]];
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: transform,
    gradientStops: stops.map(s => ({
      position: s.position,
      color: {
        r: s.color.r,
        g: s.color.g,
        b: s.color.b,
        a: s.color.a
      }
    }))
  };
}
function parseColorIsStop(tok) {
  // Returns true if the token begins with a parseable color (i.e. it's a stop, not a shape/position spec)
  if (!tok) return false;
  const m = tok.trim().match(/^(rgba?\([^)]*\)|hsla?\([^)]*\)|hwb\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/);
  if (!m) return false;
  return parseColor(m[1]) != null;
}
function parseGradientStops(tokens) {
  // Each token can be: <color> [<position>] or <color> <position> <position>
  // Color may contain spaces inside parens.
  const stops = [];
  const colorRe = /^\s*(rgba?\([^)]*\)|hsla?\([^)]*\)|hwb\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*(.*)$/;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].trim();
    if (!tok) continue;
    const m = tok.match(colorRe);
    if (!m) continue;
    const color = parseColor(m[1]);
    if (!color) continue;
    const tail = m[2].trim();
    if (!tail) {
      stops.push({
        color,
        position: null
      });
    } else {
      const posTokens = tail.split(/\s+/);
      // First position
      const p1 = parsePosToken(posTokens[0]);
      if (p1 != null) {
        stops.push({
          color,
          position: p1
        });
        // CSS allows a second position: emits a second stop with same color
        if (posTokens[1]) {
          const p2 = parsePosToken(posTokens[1]);
          if (p2 != null) stops.push({
            color,
            position: p2
          });
        }
      } else {
        stops.push({
          color,
          position: null
        });
      }
    }
  }
  // Fill in missing positions evenly
  if (!stops.length) return [];
  if (stops[0].position == null) stops[0].position = 0;
  if (stops[stops.length - 1].position == null) stops[stops.length - 1].position = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].position == null) {
      // Find next defined position
      let nextIdx = stops.length - 1;
      for (let j = i + 1; j < stops.length; j++) {
        if (stops[j].position != null) {
          nextIdx = j;
          break;
        }
      }
      const prev = stops[i - 1].position;
      const next = stops[nextIdx].position;
      const gap = (next - prev) / (nextIdx - i + 1);
      stops[i].position = prev + gap;
    }
  }
  // Clamp
  return stops.map(s => ({
    color: s.color,
    position: clamp(s.position, 0, 1)
  }));
}
function parsePosToken(t) {
  if (!t) return null;
  if (t.endsWith('%')) {
    const v = parseFloat(t) / 100;
    return isNaN(v) ? null : v;
  }
  // Assume px → can't normalize without container width, treat as undefined
  if (t.endsWith('px')) return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// ---------- Naming ----------

function makeName(tn) {
  const tag = (tn.tag || 'el').toLowerCase();
  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n || 30);

  // Text leaf → the text itself
  if (tn.text && tn.text.content) {
    return clip(tn.text.content, 40);
  }

  // Images → alt text, or a clean "Image" label
  if (tn.image) {
    if (tn.alt) return 'Image · ' + clip(tn.alt, 30);
    return 'Image';
  }
  if (tn.svg) return tn.ariaLabel ? ('Icon · ' + clip(tn.ariaLabel, 24)) : 'Icon';

  // Semantic landmarks → friendly section names, enriched with the nearest heading
  const LANDMARK = {
    header: 'Header', footer: 'Footer', nav: 'Nav', main: 'Main',
    section: 'Section', article: 'Article', aside: 'Aside', form: 'Form',
    ul: 'List', ol: 'List', figure: 'Figure', table: 'Table'
  };
  if (LANDMARK[tag]) {
    const heading = firstHeadingText(tn);
    return heading ? (LANDMARK[tag] + ' · ' + clip(heading, 28)) : LANDMARK[tag];
  }

  // aria-label / role give human intent
  if (tn.ariaLabel) return clip(tn.ariaLabel, 34);

  // Links and buttons → their label text
  if (tag === 'a' || tag === 'button' || tn.role === 'button') {
    const t = firstHeadingText(tn) || allText(tn);
    if (t) return (tag === 'a' ? 'Link · ' : 'Button · ') + clip(t, 24);
  }

  // A frame that contains a heading → name by the heading
  const h = firstHeadingText(tn);
  if (h) return clip(h, 34);

  // Fall back to a readable class name
  if (tn.class) {
    const c = tn.class.split(' ').filter(Boolean)[0];
    if (c && !/^(css-|sc-|framer-|jsx-)/.test(c)) return c.slice(0, 24);
  }
  if (tn.id) return '#' + tn.id;
  return tag;
}

function firstHeadingText(tn) {
  if (!tn) return '';
  if (tn.tag && /^h[1-6]$/.test(tn.tag) && tn.text && tn.text.content) {
    return tn.text.content;
  }
  if (tn.children) {
    for (const c of tn.children) {
      const t = firstHeadingText(c);
      if (t) return t;
    }
  }
  return '';
}

function allText(tn, depth) {
  depth = depth || 0;
  if (!tn || depth > 4) return '';
  if (tn.text && tn.text.content) return tn.text.content;
  if (tn.children) {
    for (const c of tn.children) {
      const t = allText(c, depth + 1);
      if (t) return t;
    }
  }
  return '';
}

// ---------- Helpers ----------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function report(pct, label) {
  try {
    figma.ui.postMessage({
      type: 'progress',
      pct,
      label
    });
  } catch (_e) {}
}