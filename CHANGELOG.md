# Changelog

## v0.4.12 — 2026-05-30

### Fix: SVG icons missing colors / strokes / glow

Diagnosed from a real bento-grid landing page where the lightning bolt, the recharge ring, and the airline plane were either invisible or wrong color. Five separate bugs, all shipped:

- **Capture: SVG presentation styles now inlined.** Standalone SVGs lost their fills and strokes after serialization because (a) `<path fill="var(--acid)">` left the CSS variable literal in the source, (b) class-styled `<circle class="track">` had its stroke defined in a page `<style>` block that no longer applies, and (c) `currentColor` had no resolved value. New `serializeSvgWithInlinedStyles()` clones the SVG and walks both trees in lockstep, copying each element's computed style (fill, stroke, stroke-width, dash, opacity, transform) onto the clone as attributes. The serialized output is self-contained — Figma's createNodeFromSvg now sees real colors. Applied to both the main SVG node path and the rasterize fallback.
- **Capture: all background gradient layers stored.** capture.js was keeping only the first layer because of an `if (!backgroundGradient)` early-exit. Stacked patterns (the grid lines on every card = two linear-gradients, the page bg = two radial glows) lost everything past layer one. Now collects all into `node.styles.backgroundGradients` and keeps `backgroundGradient` set to layer 0 for the gradient-text path and any older render code. Same fix in `capturePseudoBox`. The Figma plugin's render side already reads the array since v0.4.9.
- **Capture: text-content pseudo-elements come through.** `::after { content: "%" }` on the `87` LCD (and any inline text-only pseudo) was dropped because `capturePseudoBox` only handles pseudos that paint a background. New `getPseudoTextRun()` parses string-literal `content` and the inline-text branch splices it in as a text run at the head or tail of the parent's text — so 87 becomes "87%" with the % at 10px instead of 20px.
- **Render: \n in text is now a real line break.** `collapseWhitespace` was running `text.replace(/\s+/g, ' ').trim()` which destroyed every newline. Headlines that used `<br>` between phrases ("Power up,<br>Game on.") collapsed to one line. Fixed by preserving \n while collapsing other whitespace and capping consecutive breaks at two.
- **Render: drop-shadow filter actually applies to SVG icons.** The regex expected `Xpx Ypx blurpx color` but Chrome's computed `filter` value is `drop-shadow(color Xpx Ypx blurpx)` — color first. The bolt, plane, and ring all carry a green drop-shadow in their captured styles; none of them were getting the glow. New parser handles either order, zero values written without `px`, hex/named/rgba colors, and multiple stacked drop-shadows. Self-tested against seven shapes of CSS.

### What to do to see the fixes

Capture-side fixes (SVG, gradients, pseudo) need a fresh capture — they change what goes into the `.wsnap`. Render-side fixes (line break, drop-shadow) only need a Figma plugin reload + re-import of an existing `.wsnap`. For the full picture: reload the Chrome extension at `chrome://extensions`, re-capture the page, reload the Figma plugin, then re-import.

### Still pending (next pass)

- Render: tile repeating gradients + finite background-size (grid pattern on cards, diagonal stripes on pb-deco) — still rendering as a single non-repeated gradient. Needs UI-thread tile baking or capture-side rasterization of the pattern.
- Render: line-height "padding" in text nodes — line-height < font-size cases need a closer look.
- Render: investigate the Nexode 130W / Genshin Impact Edition swap in the center card — DOM order is correct in the capture, but the rendered order looks reversed.
- Render: investigate the small (5×15) `.batt-tip` rect showing up empty even with backgroundColor captured.
- Capture: mask-image icons (the `radial-gradient(...)` vignette on `.grid-bg`) — currently skipped.

---

## v0.4.11 — 2026-05-23

### Fix: viewport capture no longer resizes the window or dismisses the popup

- **Before:** selecting a viewport (e.g. 390, 768) and pressing Capture resized the whole Chrome window via `chrome.windows.update` to force the page to render at that width. The resize dismissed the action popup, so the capture never started and you had to reopen the extension and capture again. Jarring and a broken UX.
- **Fix (popup.js):** the window is never resized now. The chosen width is emulated via the DevTools protocol (`chrome.debugger` + `Emulation.setDeviceMetricsOverride`), the same mechanism as DevTools responsive mode, so CSS media queries / breakpoints fire at the target width. Two new helpers, `applyViewportEmulation()` and `clearViewportEmulation()`, manage the override; `restoreViewport()` replaces the old `restoreWindowWidth()` and runs on done, error, and abort. The page returns to its normal size automatically once the capture finishes.
- **Faithful breakpoints:** because emulation drives the real layout viewport (not just a CSS width), `window.innerWidth` and `getBoundingClientRect` report the emulated width, and responsive layouts actually switch. Mobile widths now capture as mobile.
- **Graceful fallback:** if emulation can't attach (e.g. DevTools is already open on the tab), capture falls back to the current width with a toast instead of failing.
- **Safety net (background.js + capture.js):** if the popup ever closes mid-capture, the background worker detaches the debugger on `captureResult` / `captureError` so the tab never gets stuck in emulated size with the debugging infobar showing. The existing auto-save still writes the `.wsnap`, so no recapture is needed.
- **Manifest:** added the `debugger` permission (required for viewport emulation). Reload the extension at `chrome://extensions` to pick it up.

### Notes

- Viewport emulation shows a small "WebSnap started debugging this browser" infobar while capturing. It disappears the moment the capture finishes and the debugger detaches. This is unavoidable with the DevTools protocol and matches the README roadmap item ("Chrome device emulation via chrome.debugger API").

### Verified

- popup.js, background.js, capture.js all pass `node --check`. No leftover references to the removed window-resize path.

---

## v0.4.10 — 2026-05-23

### Fix: local HTML files (file://) can now be captured

- **Before:** `isCapturable()` in popup.js only allowed `http(s)` URLs, so clicking Capture on a local `file://` page (including the bundled test pages) bailed instantly with "Cannot capture this page (chrome://, file://, or store)". Local files were impossible to snapshot.
- **Fix (popup.js):** `isCapturable()` now allows `file://` alongside `http(s)`. `chrome://`, `chrome-extension://`, and Web Store pages stay blocked. The rejection toast was updated since file is no longer unsupported.
- **Naming (popup.js + background.js):** `file://` URLs have an empty `hostname`, so captures named themselves `WebSnap__<time>.wsnap` with a blank label and the result/recent UI showed nothing. New `displayName()` helper derives the name from the filename instead (e.g. `test-01-grid-flex`), falling back to hostname for http(s). Used in the result label, recent list, and both download paths (popup download + background auto-save).
- **Manifest synced:** version was lagging at 0.4.5 while the changelog had already moved to 0.4.9. Bumped `manifest.json` to 0.4.10 to bring them back in line.

### Requires

- Chrome blocks every extension from `file://` pages by default. Enable **Allow access to file URLs** on WebSnap at `chrome://extensions`, then reload the extension. Without it, the capture.js injection fails with "Failed to inject capture script".

### Notes

- The bundled test pages are self-contained (no external images), so they capture in full. Real local files with relative `<img>`/`url()` assets may drop those images, since Chrome blocks `file://` fetches and taints the canvas. Gradients, inline SVG, and data-URI images are unaffected.

### Verified

- popup.js, background.js, capture.js all pass `node --check`. `displayName()` and `isCapturable()` unit-tested against `file://`, `http(s)`, `chrome://`, and `chrome-extension://` inputs.

---

## v0.4.9 — 2026-05-21

### Fix: multi-layer background-image now fully captured

- **Before:** when `background-image` contained multiple comma-separated gradients (e.g. `"linear-gradient(…), linear-gradient(…)"`), the importer extracted only the first layer. Everything else was silently dropped. This caused "gradient over gradient" to show only the dark overlay, "radial + linear" to appear nearly white, etc.
- **Root cause:** `bgImg.indexOf('(')` / `bgImg.lastIndexOf(')')` grabbed from the very first `(` to the very last `)` in the whole string — producing a `raw` that included both gradients plus garbage text in between. Only one `{type, raw}` object was stored anyway.
- **Fix (ui.html):** Both the main-element and pseudo-element gradient capture paths now split `backgroundImage` by top-level commas (ignoring commas inside parens) before parsing. Each layer gets its own `{type, raw}` object. The full array is stored as `node.styles.backgroundGradients`. `backgroundGradient` is kept as `backgroundGradients[0]` for gradient-text backward compat.
- **Fix (code.js — applyVisualStyles):** Reads `backgroundGradients` array first (falls back to `[backgroundGradient]` for old data). Pushes fills in reverse CSS order so the first CSS layer ends up topmost in Figma's fill stack — matching CSS visual stacking.
- **Fix (code.js — hasBg / nodeHasVisualStyle):** Both checks now also look at `backgroundGradients.length` so multi-layer elements still get a frame wrapper.

---

## v0.4.8 — 2026-05-21

### Test fix: z-index stacking test was broken (test-05, Test 4)

- `test-05-effects-pseudo.html` Test 4 had `stack-a/b/c/d` divs missing `class="stack-item"`. Without it, the `position: absolute; width: 160px; height: 100px; display: flex` styles never applied — the browser rendered 4 full-width block divs instead of 4 overlapping 160×100 cards. The plugin was working correctly all along. Added `stack-item` to each div's class list.

---

## v0.4.7 — 2026-05-21

Three more fixes from round-2 testing. Changes in ui.html and code.js — reload the plugin.

### CSS Grid children now position correctly (grid-column:span 2, asymmetric tracks)

- Forms and grids with multi-column spanning items were importing in the wrong order/position when Auto Layout mode was on. Root cause: Figma's wrap auto-layout treats every child equally and has no concept of `grid-column: span N`. The importer now detects `display: grid` / `inline-grid` parents and always uses pixel-perfect absolute positioning for their children — the captured `getBoundingClientRect` coords are the exact answer and don't need any translation. This fixes "Email address" spanning full width, correctly sized first/last name side-by-side fields, and any other spanning/asymmetric grid.

### docH still inflated on pages with min-height:100vh on inner containers

- After v0.4.6, some pages (e.g. dark/glassmorphism test) still had excess empty space at the bottom. The v0.4.6 fix computed height from the deepest tree rect, but if an inner section has `min-height: 100vh` its own rect is 5000px even though its children only reach e.g. 1400px. The `maxBottom` traversal was using the container's own rect, which overshoots. Fixed: when a node's rect extends 300px+ below its deepest child, the children's bottom is used instead of the node's own bottom.

### HTML upload: z-index, backdrop-filter, mix-blend-mode, outline now captured

- `HTML_STYLE_KEYS` in ui.html was missing a dozen properties that the Chrome extension already captured. Added: `z-index` (z-order sorting now works for HTML uploads), `backdrop-filter` / `-webkit-backdrop-filter` (glass/blur effects no longer invisible), `mix-blend-mode`, `outline-width/style/color/offset`, `text-shadow`, `text-decoration-color`, `word-spacing`, `align-content`, `cursor`. HTML upload and Chrome extension are now fully in sync.

---

## v0.4.6 — 2026-05-21

Three HTML-upload bugs fixed by testing against targeted test pages. All changes are in the Figma plugin (ui.html) and Chrome extension (capture.js). Reload the plugin to pick up the fixes.

### Empty canvas below page content (docH inflation)

- HTML files with `min-height: 100vh` on the body produced a huge empty space at the bottom of the import. Root cause: the sandbox iframe is 5000px tall, so `100vh = 5000px`, making `scrollHeight` report 5000px even on a 1600px page. Fixed by computing the document height from the deepest bounding rect in the captured tree instead of `scrollHeight`. A real 1600px page now imports as ~1680px, not 5000px.

### Styled inline-block elements (pill badges, chips) losing their background

- A `<span class="badge">` with `display: inline-block` and a colored background was being collapsed to a plain text node, dropping its background-color, border-radius, and padding. The `isInlineLayoutContainer` check treated all SPAN children as "just inline text" without inspecting whether they had visible styling. Fixed: inline-block/inline-flex children with a non-transparent `background-color` now break out of the text-collapse path so each badge gets its own styled frame. Applied to both the HTML upload parser (ui.html) and the Chrome extension capture (capture.js).

### Pseudo-elements (::before / ::after) missing on HTML uploads

- `::before`/`::after` decorative boxes worked in Chrome extension captures (v0.4.0) but were never wired up in the HTML file upload path. The same conservative capture logic is now ported to `buildHtmlTree` in ui.html: pseudo-elements that paint a background (solid color or gradient) are captured as real nodes; text-content pseudos and mis-measured oversized ones are skipped. Gradient borders, accent bars, dividers, and overlay scrims now appear on HTML uploads too.

### Verified

- All five test pages (grid/flex, dark/glass, typography, tables/forms, effects/pseudo) re-imported. docH now matches content height. Pill badges render as styled frames. ::before/::after gradient dividers and overlay nodes appear.

---

## v0.4.5 — 2026-05-21

More from the AERA (MagicPath) import: wider Auto Layout coverage and the cover-art text. Render-side, so reload the plugin and re-import.

### Auto Layout covers far more of the page

- Flex/grid containers now always become Auto Layout (geometry spacing means they can't collapse), so the big center column stops importing as a plain frame. Block containers that are clean vertical stacks become Auto Layout too. Containers Auto Layout genuinely can't represent (clipped scrollers/marquees where a child sits outside its box, like the audio waveforms) stay pixel-perfect absolute instead of getting forced into a single spacing and shooting 279px off.
- On the AERA page: 90 containers come in as Auto Layout (was 79), 1 flex scroller stays absolute, and the worst child placement error is 12px (on the sidebar, where the logo-to-nav gap is intentionally bigger than the gaps between nav items, which one spacing can't capture). p95 is 0.08px.

### Cover-art text no longer breaks mid-word

- The album cover is an SVG with `<text font-family="Georgia">Breathe</text>` baked in. Figma's SVG import substitutes the font and wraps it ("Breathe" -> "Brea/the"). SVGs that contain `<text>` now render from the rasterized fallback the capture already made (with the real page font), so the cover reads correctly. Icon SVGs (no text) stay editable vectors.

### Verified

- Full suite: 46 + 13 + 14 + 7 + 7 + 5 + 4 + 7 + 18 + 3 tests pass, e2e passes.
- Auto-layout fidelity re-measured on the real AERA capture (12px worst-case, one scroller correctly kept absolute).

---

## v0.4.4 — 2026-05-21

Auto Layout rebuilt to be faithful. Found by importing the AERA Music (MagicPath) page with Auto Layout on: the whole center column collapsed to the top. Render-side, so reload the plugin and re-import the existing `.wsnap`.

### Auto Layout is now derived from the captured geometry, not CSS

- The old path read CSS `gap` and `justify-content` to set spacing. This page has no `gap` (its spacing comes from margins), so `itemSpacing` came out 0 and every column packed tight at the top. The captured rects are ground truth (that's exactly why the non-Auto-Layout import looks perfect), so spacing, padding, and cross-axis alignment are now measured straight from the child positions. itemSpacing is the median real gap, padding is the real leading/trailing offset, and the cross-axis alignment (left/center/right) is chosen by best fit to where the children actually sit.
- Where a container's spacing is uneven and a single `itemSpacing` can't reproduce it, that container falls back to pixel-perfect absolute positioning instead of guessing, so nothing ever collapses. Everything else becomes clean, resizable Auto Layout.
- On the AERA page: 79 containers became Auto Layout, 4 fell back to absolute, and across 289 laid-out children the worst placement error is 0.5px (p95 is 0px). Before this, the column collapsed entirely.

### Verified

- Full suite: 46 + 13 + 14 + 7 + 7 + 5 + 4 + 7 + 16 tests pass, e2e passes.
- Auto-layout fidelity measured on the real AERA capture (0.5px worst-case child drift).

---

## v0.4.3 — 2026-05-21

Two render bugs found by importing a real AERA Music page (built with MagicPath). Both are render-side, so they take effect on a plugin reload + re-import of the existing `.wsnap` — no re-capture needed.

### Loose labels next to an icon no longer disappear

- An element that carries both its own direct text and child elements (the icon-then-label button: `<button><svg/>Forest Calm</button>`) was rendered as a frame holding the icon, and the label text was silently thrown away. That killed the left-nav labels (Now Playing, Discover, ...) and the bottom mood-pill labels, while the same words rendered fine wherever they lived in their own element (the NATURE MOODS list). The renderer now turns that loose text into a real text layer placed next to the icon. Regression test covers the icon+label button and confirms both the icon and the label survive.

### Single-line text no longer breaks mid-word

- A one-line text box set to a fixed width got broken across lines when the substituted font is wider than the original, so a centered heading like "Breathe" rendered as "Brea / the" and collided with its subtitle. Single-line text is now auto-width (it can't wrap), and center/right-aligned text is re-anchored so it doesn't drift. Multi-line text keeps a fixed width so real wrapping is preserved. Regression test covers single-line auto-width and multi-line fixed-width.

### Verified

- Full suite: 46 + 13 + 14 + 7 + 7 + 5 + 4 + 7 tests pass, e2e passes.
- Confirmed a no-op on the older jimo.ai capture (0 nodes hit the new path there), so no regression on existing imports.

---

## v0.4.2 — 2026-05-20

Two capture regressions found by importing a real jimo.ai page (a heavy Framer site). Both were cases where the capture showed content the live page hides.

### Logo marquees no longer scroll off-screen

- The capture forced `animation-iteration-count: 1` on everything, then called `.finish()` on every animation. For an infinite logo marquee that fast-forwarded it to fully scrolled, so the logos ended up at negative x (off the left edge) and the row looked empty. On jimo that was 12 logos sitting at x = -991 to 1140. Now infinite animations (marquees, tickers, spinners) are reset to their first frame and paused, so the content sits at its natural rest position. Finite scroll-reveal animations still jump to their visible end state as before. Regression test covers both branches.

### Collapsed accordion answers no longer overlap the questions

- Closed accordion panels keep their answer text in the DOM (the wrapper collapses to ~1px, the answer overflows it, the live page clips it). The capture was emitting that hidden answer at full height, so it rendered on top of the question and the FAQ looked garbled. Now an in-flow (`position: static`) element that vastly overflows a near-zero-height parent is treated as collapsed-panel content and skipped. Absolutely-positioned content inside Framer's zero-size positioning wrappers is explicitly preserved. Regression test covers accordion answer, normal text, and the Framer wrapper case.

### Verified

- Full suite: 46 + 13 + 14 + 7 + 7 + 5 + 4 tests pass, e2e passes.
- Both fixes are capture-side, so they need a fresh capture to take effect.

---

## v0.4.1 — 2026-05-20

Bugfix found by running a real jimo.ai capture (1,639 nodes, 146 images) through the renderer.

### Inline images used more than once no longer vanish

- `registerAsset` minted a fresh asset id every time it saw a `data:` URI but wrote them all to the same map key, so when the same inline image appeared in several places only the last id survived. Every earlier reference pointed at an asset that wasn't in the file, and those backgrounds silently disappeared on import. On the jimo.ai test that was 66 background-image references pointing at nothing. The `url()` path already deduped; the `data:` path now does too. New regression test: same inline image on three elements resolves to one id with no dangling references.

### Verified on real data

- jimo.ai capture renders through the real `code.js`: 940 layers (after wrapper cleanup), 22 gradients, 0 errors, 236ms.
- Full suite: 46 + 13 + 14 + 7 + 7 tests pass, e2e passes.

---

## v0.4.0 — 2026-05-20

Universality pass: stop being a marketing-site tool and start handling any site or dashboard. Two coverage gaps closed that show up everywhere once you leave hand-built landing pages: icon fonts and decorative pseudo-elements, plus native form controls that used to render as junk.

### Icon fonts (Font Awesome, Material Symbols, etc.)

- Glyph icons (a single character in an icon font) now rasterize to a small PNG instead of dropping to a missing-glyph box or the literal PUA character. Detection covers the common families (Font Awesome, Material Icons/Symbols, Ionicons, Feather, Remix, Bootstrap Icons, Phosphor, Tabler, Lucide, Dashicons, and `fa-`/`fas`/`far`/`fab` class hints) plus generic Private-Use-Area codepoints, so unknown icon fonts still get caught. Normal text is never misclassified.

### Pseudo-elements (`::before` / `::after`)

- Decorative pseudo-elements that paint a background (color, gradient, or `url()` image) are now captured as real layers. This is the common case for scrims, dividers, overlays, badges, and gradient borders that were previously invisible. Placement is computed from the parent rect plus the pseudo's own `position`/offsets; corner radius, opacity, box-shadow, and `mix-blend-mode` carry through. Conservative on purpose: text-content pseudos and anything with no paintable background are skipped, and mis-measured oversized boxes are dropped, so no junk layers.

### Native form controls

- Native (un-styled) checkboxes and radios now render as a proper box / circle with the page's `accent-color` fill when checked and a gray outline when not, instead of an empty box with a stray `"on"` label. Custom-styled controls (`appearance: none` with their own CSS) are left exactly as captured. Text inputs, textareas, and selects keep their value/placeholder as before.

### Verified

- 46 + 13 parser/CSS tests pass, e2e passes, new form-control test 14/14, all files syntax-clean ✓

### Still out of scope (honest limits)

- WebGL / 3D canvas, cross-origin video frames, and content that only exists after a user interaction can't be captured — they're not in the DOM as styled boxes. 2D canvas (charts) does capture via `toDataURL`.

---

## v0.3.0 — 2026-05-20

Product-quality pass: make the imported file clean and usable, not a flat 2000-layer mess.

### Layer cleanup

- **Flatten meaningless wrapper divs.** A new tree-simplification pass removes pure passthrough wrappers — elements with no fill, border, shadow, text, image, semantic role, clip, or fixed/sticky position — and promotes their children. Real pages nest content in many more divs than have visual meaning. Positionally safe in pixel-perfect mode (children carry absolute coords). On a flex-heavy site like intercom this cut the layer count ~22%; on wrapper-heavy Framer sites it's much more. New "Clean up layers" toggle (on by default). Only runs in pixel-perfect mode (auto-layout off).

### Semantic layer naming

- Layers now get meaningful names instead of `div.framer-x7y2`:
  - Text → the text content
  - Images → `Image · <alt text>`
  - Icons (SVG) → `Icon · <aria-label>`
  - Landmarks → `Header`, `Footer`, `Nav`, `Section · <nearest heading>`, `List`, etc.
  - Links / buttons → `Link · <label>` / `Button · <label>`
  - Frames containing a heading → named by the heading
  - Falls back to a clean class name (skips hashed `css-`/`sc-`/`framer-` noise) then tag
- Capture now records `alt`, `aria-label`, and `role` for naming.

### Reliability & UX

- **Yields to the event loop every ~120 nodes during import** so Figma's UI stays responsive on large pages instead of freezing.
- **Empty-capture guard** with a clear message ("nothing to import — re-capture after the page loads") instead of a silent no-op.
- **Large-page warning** in the plugin preview when a capture exceeds 3000 layers, so the wait isn't a surprise.

### Verified

- 46 + 13 unit tests pass, e2e passes, all files syntax-clean ✓
- Cleanup measured on real intercom capture: 419 → 325 nodes, names like "Button · Product", "Section · ...", "Image" ✓

### Note on component detection

True Figma components (repeated cards → component + instances with per-instance content) is intentionally deferred. The naive version makes every card show the first card's content, which is worse than separate frames. Doing it right needs Figma component properties (text/instance-swap) — a careful v2 feature. The cleanup + naming above already make the file navigable and editable.

---

## v0.2.0 — 2026-05-20

The three "make it feel professional" features from the audit roadmap.

### Real viewport resizing

The viewport buttons now actually work. Before capturing at a chosen width (1920/1440/1024/768/390), the popup resizes the browser window so the page genuinely renders at that viewport, then captures, then restores the original window size. Previously the buttons only labeled the output; they captured whatever width the window happened to be. Measures the browser-chrome delta (outer vs inner width) so the target inner width is accurate. "Current" skips resizing. Restores on success, error, and cancel.

### Inline text runs (per-range styling)

A bold or colored word inside a sentence now keeps its formatting. Capture records text as styled segments (runs) by walking text nodes and reading each one's computed style, merging adjacent identical runs. The renderer applies them with `setRangeFontName` / `setRangeFontSize` / `setRangeFills` / `setRangeTextDecoration` / `setRangeLetterSpacing` over the matching character ranges. Fonts for all runs are preloaded. Only stored when a text block has more than one distinct run, so simple text stays lightweight.

Verified: "Powering **ambitious** teams" with a bold red middle word → "ambitious" isolated to its exact character range with bold weight + red fill.

### Capture persistence (don't lose work)

Closing the popup mid-capture no longer loses the result. The popup holds a presence port to the background worker. capture.js sends the finished result to the background as a safety net. If the popup is closed when a capture completes, the background auto-saves the `.wsnap` to Downloads and shows a notification. If the popup is open, it handles the result as before (no auto-download). Wired up the previously-inert Cancel button too.

### Also in this release (from v0.1.19 quick wins)

Fixed broken `parsePctOr` math (lab/lch colors), text clipping with substituted fonts (HEIGHT auto-resize), animations frozen mid-flight (finish not pause), one-sided border detection, and removed dead code.

### Verified

- 46 + 13 unit tests pass, e2e passes, all 4 JS files syntax-clean ✓
- Inline-run offset matching verified via JSDOM ✓
- Figma setRange* APIs are standard + try/catch wrapped ✓

### Pick-up

This touches capture and render. Reload BOTH: Chrome extension (v0.2.0) and the Figma plugin. Re-capture to get viewport resizing + inline runs + persistence.

---

## v0.1.19 — 2026-05-20

Quick-win fixes from a deep end-to-end audit.

### Fixed

- **`parsePctOr` broken math** — had no-op `*1` multipliers, so `lab()`/`lch()` with percentage lightness produced wrong colors. Now correct.
- **Text clipping with substituted fonts** — wrapped text used `textAutoResize='NONE'` with a fixed height from the original font's metrics; when Inter substituted in, taller text got clipped. Now uses `HEIGHT` auto-resize so text grows instead of clipping (safe with pixel-perfect absolute positioning).
- **`finishAllAnimations` froze animations mid-flight** — it called `pause()` on unfinished animations, capturing a random frame. Removed; now only `finish()` (jump to end state).
- **Text-wrap decision only checked top border** — a left/right/bottom-only border on a text element was dropped. Now checks all four sides and all corner radii.
- **Wired up the Cancel button** — was inert. Now disconnects the active capture and resets the popup.
- Removed an unused variable in `nodeName`.

### Verified

- 46 + 13 unit tests pass, e2e passes, all 4 JS files syntax-clean ✓

---

## v0.1.18 — 2026-05-20

Proactive coverage pass instead of reactive whack-a-mole. Ran a full CSS-feature audit of capture + render, then batch-fixed every feasible gap at once.

### Added — colors

- **`hwb()`, `lab()`, `lch()`, `color(srgb …)`, `color(display-p3 …)`** parsing. Previously these returned null (transparent). Now converted to RGB.
- **Expanded named colors** from ~16 to ~55 (navy, teal, gold, coral, crimson, indigo, slate, rebeccapurple, skyblue, forestgreen, etc.).

### Added — gradients

- **Radial gradients** → Figma `GRADIENT_RADIAL`. Was linear-only (radial silently dropped).
- **Conic gradients** → Figma `GRADIENT_ANGULAR`.
- **`repeating-*` gradients** detected and rendered as their base type.
- Radial/conic position/shape specs (`circle at center`, `85% 77% at 50% 22%`, `from 0deg`) are skipped cleanly so stops parse correctly.

### Added — text

- **Gradient / clipped text** (`background-clip: text` + `color: transparent`). Common in hero headlines. The gradient is now applied directly as the text node's fill instead of the text rendering invisible/black.
- **`text-shadow`** → DROP_SHADOW effect on the text node.

### Added — effects & blend

- **`backdrop-filter: blur()`** → Figma `BACKGROUND_BLUR` (glassmorphism navbars and cards).
- **`mix-blend-mode`** → Figma `blendMode` (multiply, screen, overlay, darken, lighten, etc.). Was captured but never applied.

### Added — borders

- **Per-side borders.** A bottom-only divider, underlined input, or one-sided accent border now uses Figma's individual stroke weights (`strokeTopWeight` / `strokeBottomWeight` / etc.) instead of drawing a full box outline.

### Capture additions

- `backdrop-filter`, `-webkit-backdrop-filter`, `text-shadow`, `-webkit-background-clip` added to the captured style set (both Chrome capture and HTML-upload parser).

### Verified

- 46 core unit tests + 13 new CSS-format tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓
- New Figma node properties (BACKGROUND_BLUR, GRADIENT_RADIAL, GRADIENT_ANGULAR, blendMode, per-side stroke weights, gradient text fills) are standard Figma API, each wrapped in try/catch.

### Coverage status (what WebSnap now handles)

Colors: hex, rgb(a), hsl(a), hwb, oklch, oklab, lab, lch, color(), 55 named, transparent, currentColor (svg).
Gradients: linear, radial, conic, repeating, multi-stop, gradient text.
Backgrounds: color, image, layered, size, image fills.
Borders: uniform, per-side, per-corner radius, outline, dashed/dotted.
Effects: box-shadow (outer/inner/multi), drop-shadow, blur, backdrop-blur, text-shadow.
Text: full font chain, weight, size, italic, line-height, letter-spacing, align, transform, decoration, nested color, gradient text.
Layout: flex→auto-layout, grid→wrap, absolute, z-index, fixed/sticky to front, flex-grow, align-self, gap, overflow clip, carousel clip.
Transforms: rotate, scale/translate (baked into rect).
Images: img, picture, srcset, canvas, video frame, webp/avif→png, object-fit, inline+external SVG vectors.
Misc: opacity, mix-blend-mode.

Known not-handled (rare or no Figma equivalent): pseudo-elements ::before/::after, mixed inline text formatting (bold word inside a paragraph), list markers, clip-path, mask, CSS columns, skew, WebGL/canvas-rendered content, CORS-tainted video frames.

### Pick-up

Capture additions (backdrop-filter, text-shadow, background-clip) → re-capture to record them. All render improvements (gradients, colors, blend, borders, gradient text) → reload the Figma plugin; existing `.wsnap` files benefit from re-import for the parts already captured.

---

## v0.1.17 — 2026-05-20

The z-index fix. After WebP rendering was fixed, the intercom hero showed only the meadow background — the headline, buttons, and product screenshots were hidden behind it.

### Root cause

Intercom's hero (a very common pattern) places the foreground content FIRST in the DOM with `z-index: 40`, and the background image LATER in the DOM with a low z-index. CSS honors z-index, so foreground sits on top. Figma has no z-index — it stacks purely by tree order — so the background (later in tree) was rendering on top of the foreground and hiding it.

### Fixed

- **Children are now appended in z-index order.** Before attaching children to their parent, they're sorted by computed `z-index` (stable sort, so equal values keep DOM order). Higher z-index appends later = renders on top, matching CSS stacking. This correctly places foreground content over background images.

### Verified

- Logic test: foreground (z-40, first in DOM) + background (z-0, last in DOM) → foreground ends up on top ✓
- Equal z-index preserves DOM order ✓
- 46 unit tests pass ✓
- E2E test passes ✓

### Pick-up

Render-side fix → just reload the Figma plugin and re-import your existing intercom `.wsnap`. No re-capture needed. The hero headline, buttons, and product screenshots should now sit on top of the background.

---

## v0.1.16 — 2026-05-20

The WebP fix. Diagnosed from a clean intercom.com capture: 56/56 images captured, 0 failed, header present — yet product screenshots showed as gray boxes and the header looked missing.

### Root cause

Figma's `figma.createImage()` only decodes PNG, JPG, and GIF. **It cannot decode WebP or AVIF.** Intercom (and most modern sites using Next.js image optimization) serve WebP. Of 56 assets: 35 PNG and 4 JPEG rendered fine; 17 WebP failed and fell back to the gray placeholder. The "missing header" was the same bug — the hero's WebP background rendered as a gray box stacked on top of the fixed header, hiding it.

### Fixed

- **WebP / AVIF / JXL / HEIC → PNG conversion in the background fetch.** When the privileged background fetch pulls an image in an unsupported format, it now decodes it via `createImageBitmap` and re-encodes to PNG through `OffscreenCanvas` (falls back to JPEG if the PNG exceeds 3 MB). Figma renders the result.
- **WebP conversion in the plugin UI too.** Before sending a capture to the canvas, the plugin scans assets for WebP/AVIF data URIs and converts them to PNG via canvas. This means **existing `.wsnap` files** with WebP assets now render correctly without re-capturing.
- **`position: fixed` / `sticky` elements brought to front.** CSS gives these high stacking order; Figma uses tree order. Fixed headers were rendering behind later siblings (like full-bleed hero images). Now they're moved to the top of their parent's z-order, so headers stay visible.

### Verified

- Confirmed via `.wsnap` analysis: 17/56 assets were WebP ✓
- 46 unit tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓

### Pick-up

- Best result: reload extension (v0.1.16) and re-capture — images convert during capture, smaller files.
- Quick win: just reload the Figma plugin and re-import your existing intercom `.wsnap` — the UI-side WebP conversion will render the gray boxes correctly.

---

## v0.1.15 — 2026-05-15

The invisible footer links fix.

### Diagnosis

The footer links (AI, Design, Publish, Pricing, etc.) WERE being captured and rendered — but as **black text on a black background**, so they were invisible. The column headings (Product, Solutions...) showed because they were white.

Found via `.wsnap` analysis: Framer's footer links nest like `<li style="color:black"><a style="color:white">AI</a></li>`. When my capture collapsed the `<li>` to a text node (because `<a>` is inline), it used the `<li>`'s color (black) instead of the inner `<a>`'s color (white).

### Fixed

- **Text style now drills down to the element that actually carries the text.** When collapsing an inline container to a text node, the capture walks down through wrapper elements that contain the same text and uses the deepest one's computed style (color, font-weight, etc.). So `<li black><a white>AI</a></li>` now captures white, matching what's visible on the page.
- Applied to both the Chrome capture and the HTML-upload parser.

### Verified

- JSDOM test: `<li color=black><a color=white>AI</a></li>` → text source resolves to `<a>` with white ✓
- 46 unit tests pass ✓
- E2E test passes ✓

### Pick-up

Capture-side fix → reload extension (v0.1.15) and **re-capture**. The footer links will come through with their correct (visible) colors.

### Known remaining limit

The "Design bold" video shows empty (no still frame) when the video is CORS-tainted — the browser blocks reading its pixels into a canvas. This is a browser security limit, not a fixable bug. The video's poster image is used when available.

---

## v0.1.14 — 2026-05-15

Fixed the storage quota crash.

### Fixed

- **`Resource::kQuotaBytes quota exceeded` error.** The "recent captures" feature in the popup was storing full capture payloads in `chrome.storage.local`, which has a ~10 MB total quota. A single framer.com capture is ~9.5 MB, so even one blew the quota and threw an uncaught error (popup.js:137).
- Now the recent list stores **metadata only** (host, dimensions, node count, size, timestamp) — a few hundred bytes per entry. The full payload is never persisted; it stays in memory (`state.lastResult`) for immediate download/copy of the current capture.
- Added one-time cleanup on popup load: strips any heavy `data` payloads left in storage by older versions, so the quota error clears itself even if it was already stuck.
- Removed the download/copy buttons from past recent entries (they relied on the stored payload). The recent list is now an informational history. To re-export a past capture, re-capture the page.

### Verified

- All 3 extension JS files syntax-clean ✓
- No `data` payloads written to `chrome.storage.local` ✓

### Pick-up

Reload the Chrome extension (v0.1.14). The error clears on next popup open. No re-capture needed for this fix specifically, but you'll want a fresh capture anyway to get the v0.1.13 video-frame fix.

---

## v0.1.13 — 2026-05-15

Two fixes from the framer.com render: the "Design bold" video box, and footer/section spacing accuracy.

### Fixed

- **Video elements now capture a real frame.** Was: capture stored the raw `data:video/mp4;base64,...` as the element's "image", which Figma can't render → gray box. Now: draws the current video frame to a canvas and stores it as PNG. Falls back to the `poster` image if the frame can't be drawn (CORS-tainted video). Never stores the mp4.
- **Pixel-perfect spacing is now the default.** Auto Layout is OFF by default. Captured pages use the exact document coordinates from the page, so spacing matches the source 1:1. This fixes footers, multi-column layouts, and any complex flex/grid arrangement that auto-layout was approximating and getting wrong.

### Why the default flipped

Auto Layout is great for editing but it recalculates positions using Figma's own spacing math, which can't perfectly reproduce arbitrary CSS flex/grid setups (e.g., framer.com's footer with `justify-content: space-between` across 4 columns of varying widths). The columns came in scattered. With Auto Layout off, every element sits at its exact captured pixel position — matching the live site precisely.

You can still turn Auto Layout ON in the plugin (toggle in the import options) if you want editable flex layout and don't mind minor spacing drift. For pixel-accurate captures, leave it off.

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓
- Confirmed asset_208 (the "Design bold" element) was a 538KB mp4 stored as an image ✓

### Pick-up notes

- Video fix is capture-side → **re-capture** to get video frames.
- Pixel-perfect default is render-side → reload the Figma plugin, re-import. (Existing .wsnap files work; they'll just render with exact positions now.)

---

## v0.1.12 — 2026-05-15

The biggest capture bug yet. Found by analyzing the actual framer.com `.wsnap`: the testimonial card had **0 images in the capture but 82 images in the live DOM**.

### Root cause

`isInlineContainer` decided whether a DOM element is a "pure text container" (capture its text, stop recursing) or a layout container (recurse into children). The check: if all children are inline-displayed, treat as text container.

The problem: Framer wraps slide content in inline-display containers that contain images nested inside `<a>` tags. Since `<a>` and `<span>` are inline, the whole slide was classified as a text container — so the capture grabbed the quote text and **threw away every nested image, avatar, and demo screenshot.**

This silently dropped 82 images from one card alone, and similar content from every Framer-style section.

### Fixed

- **`isInlineContainer` now returns false if the element has ANY media descendant** — `<img>`, `<svg>`, `<video>`, `<canvas>`, `<picture>`, `<input>`, `<button>`, `<iframe>`, or any descendant with a CSS `background-image: url(...)`. Such elements are recursed into so their media gets captured, instead of being collapsed to text.
- Pure text containers (paragraphs with `<a>`/`<span>` but no media) still collapse to a single text node — no fragmentation.
- Applied the same fix to the HTML-upload parser in the Figma plugin UI.

### Verified

- JSDOM test: container with 2 nested images → old logic dropped them (text container), new logic keeps them (recurse) ✓
- Pure text container with links but no media → still a text container ✓
- 46 unit tests pass ✓
- E2E test passes ✓

### REQUIRES RE-CAPTURE

This is a capture-side fix. Reload the Chrome extension (will show v0.1.12) and **re-capture** the page. Existing `.wsnap` files were captured with the old logic and won't have the images. A fresh capture will.

---

## v0.1.11 — 2026-05-15

The carousel fix. Long-running mystery solved: framer.com's testimonial section, expert tiles, and resource cards weren't "missing" — they were rendered correctly at their captured positions, which extended far to the right of the viewport because they're JS-driven carousels.

### Diagnosis

Analyzed the actual `.wsnap` file from a framer.com capture. Found a `<ul>` at x=256 containing 5 testimonial slides:
- Slide 1: x=256 (visible)
- Slide 2: x=1486 (off-screen right)
- Slide 3: x=2716
- Slide 4: x=3946
- Slide 5: x=5176

CSS captured `overflow: visible` on the carousel container — but on the live site, only slide 1 is visible because Framer uses JavaScript-driven transforms to translate the rail. CSS doesn't reflect that.

So my plugin rendered all 5 slides side-by-side extending 6120px to the right, creating apparent empty space in the layout where the carousel should be.

### Fixed

- **Auto-detect carousel-style overflow.** After laying out children, the renderer now checks if any child extends more than 1.5× past the parent's bounds in either direction. If so, force `clipsContent = true` on the parent regardless of captured CSS overflow.
- Works generically for carousels, marquees, and any JS-clipped scrollers.
- Cards stay visible at their natural size. The slide rail still exists in the Figma layer tree — you can still access slides 2-5 in the Layers panel if you need them — but only the first slide shows on the canvas, matching the live site.

### Why this also fixes other sections

The "Get pro help from experts" and "Launch faster with community resources" sections on framer.com are similar carousels — that's why they showed only headings. After this fix, the first card in each carousel will be visible inside the section bounds.

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓
- `.wsnap` analysis confirmed the diagnosis ✓

---

## v0.1.9 — 2026-05-15

The real Framer Motion fix. Previous attempts overrode CSS animations, but Framer Motion uses the **Web Animations API** which CSS overrides can't touch. This release uses the proper kill-switch.

### Fixed

- **`document.getAnimations().forEach(a => a.finish())`** — finishes every running CSS animation, CSS transition, AND Web Animations API animation. This is what Framer Motion, GSAP, and most React animation libraries use under the hood. Snapping them to their end state means the element ends up at its final position and opacity instantly.
- **Called during three lifecycle points:**
  1. After page-load setup (handles initial hero reveals)
  2. After every scroll step (handles IntersectionObserver-triggered reveals as they fire)
  3. After scroll passes complete (catches any last animations)
- **Aggressive inline-style reset.** Walks all elements with inline `style=` attributes and clears:
  - `opacity: 0` (animation initial state)
  - `transform: translate(...)` / `translate3d(...)` (fade-up initial state) — only when there's no rotate/scale/skew on the same element
  - `visibility: hidden`
  - `data-framer-appear-id` / `data-framer-name` element styles
- **Synthetic event dispatch.** Fires `scroll` + `resize` events to wake any custom listeners that don't use IntersectionObserver.

### Why this should finally work for framer.com

The page's missing sections — testimonial card, expert tiles, community resource tiles, CTA, footer — were all stuck at `opacity: 0` + `translateY(...)` because their Framer Motion reveal animation was running with multi-second duration. Now:

1. Capture starts
2. Initial `finishAllAnimations()` snaps page-load animations to end state
3. Slow scroll triggers IntersectionObservers for each section
4. After each scroll step, `finishAllAnimations()` snaps newly-triggered animations to end state
5. Final inline-style reset clears any leftover initial-state styles
6. DOM walk sees fully-visible content with correct final positions

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓

---

## v0.1.8 — 2026-05-15

The Framer-Motion fight. Framer's own site (and any site using Framer Motion, GSAP ScrollTrigger, or AOS) keeps content hidden behind animations that fire on scroll. The previous scroll passes weren't enough — animations had multi-second durations and elements were still mid-transition when the DOM was walked.

### Fixed

- **Inject CSS to snap all animations to their end state.** Before the scroll pass, the capture script now adds a `<style>` tag that sets:
  - `animation-duration: 0.001s`
  - `transition-duration: 0.001s`
  - `[style*="opacity: 0"] { opacity: 1 }`
  - `[data-framer-appear-id], [data-framer-name] { opacity: 1 }`

  This forces every CSS animation, transition, and Framer-Motion appear effect to be in its final visible state immediately, so the DOM walker sees fully-rendered content. Override is removed after capture so the original page is untouched.
- **Extended settle time.** 400ms after the scroll pass before walking the DOM, giving any final layout reflows and image decodes time to complete.
- **Broken-wrap text detection.** When a captured text box is so narrow that even a single word doesn't fit (e.g., "collabora" wrapping to a new line mid-word), the renderer now switches to `WIDTH_AND_HEIGHT` auto-resize so Figma flows the text at its natural width instead of preserving the broken box. Heuristic: if the longest word is approximately wider than `targetW`, the box is broken.

### Why this should help on framer.com

The headings you saw render correctly (top of the page), but every section below was stuck mid-reveal:
- The "Powering ambitious teams" testimonial card → was at opacity 0
- The expert tiles → fade-up on scroll
- The community resource tiles → fade-up
- The CTA + footer → fade-up

With animation durations forced to ~0, every scroll-into-view trigger that fires now completes instantly, leaving the elements visible at their final position by the time the DOM walker runs.

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All JS files syntax-clean ✓

---

## v0.1.7 — 2026-05-15

Lazy-load + scroll-reveal fix. Framer (and most modern marketing sites) use IntersectionObserver to fade in sections as you scroll. The previous fast scroll loop missed them.

### Fixed

- **Lazy-loaded sections at the bottom of long pages now render.** Was: the scroll pass moved at 80ms per step and only scrolled once. Sections below the fold often hadn't lazy-loaded by the time the DOM walk started. Now: 220ms per step (slower, gives IntersectionObserver time to fire), two full passes (the second catches anything that loaded during the first pass), final wait for all image load events to settle.
- **Lazy-loaded images forcibly preloaded.** Before scrolling, the capture script now:
  - Converts `loading="lazy"` → `eager` on all `<img>` and `<iframe>`
  - Copies `data-src` / `data-srcset` → `src` / `srcset` (common library patterns from LazySizes, lozad, framer-motion etc.)
  - Sets `style.backgroundImage` from `data-bg`
- **Scroll-reveal `opacity: 0` initial states no longer skip elements.** Was: elements at opacity 0 (the starting state of every Framer/GSAP fade-in animation) were dropped entirely from the tree. Now: only skipped if they're also empty (no children, no text, no image). Element renders at full opacity in Figma since opacity 0 was an animation artifact, not an authoring intent.
- **CSS `outline` captured and applied as stroke.** Cards using `outline: 1px solid …` (common for accessibility focus states or button-style borders without affecting layout box) now render with the correct stroke. Falls back to outline only when no border was set.

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All JS syntax-clean ✓
- Background fetch still working (37/37 type results from prior testing) ✓

### What this should fix for you

The framer.com capture's missing sections — the 4-grid feature row, the 2x2 expert tiles, the launch-faster row of community resource thumbnails, the CTA, the footer — should now come through. Stroke boxes around the "A/B Testing" card should render too.

---

## v0.1.6 — 2026-05-15

The image-fetch fix. The root cause of "images and SVGs don't show up" was CORS — capture.js was fetching from the page context where cross-origin assets without CORS headers are blocked.

### Fixed

- **Images now fetch via the privileged background script.** Chrome extensions get `host_permissions: <all_urls>` which lets the background service worker fetch any URL, bypassing CORS entirely. Was the page-context `fetch()`, which silently failed on most cross-origin images. Now: capture.js sends the URL to background.js via `chrome.runtime.sendMessage`, background fetches with extension privileges, returns the data URI.
- **Same fix for SVG text fetching.** External `<img src="x.svg">` now reliably gets its source pulled, so the Figma plugin can render it as editable vectors.
- **Large image downscale moved to background.** Background uses `OffscreenCanvas` to downscale >8 MB images to JPEG, returning a manageable data URI.
- **Better diagnostics.** The Chrome popup now shows `12/14 images` so you can see how many assets succeeded vs failed. If the number is suspiciously low, you'll know.

### Why this matters

Before v0.1.6, any page hosting its images on a CDN that didn't send `Access-Control-Allow-Origin: *` headers had its images dropped silently. That's most marketing sites, all of Stripe, Apple, Linear, divriots, and basically anything serving images from `cdn.example.com`. Now they all come through.

### Verified

- 46 unit tests pass ✓
- E2E test passes ✓
- All 4 JS files syntax-clean ✓
- Page-context fallback retained — if background script is asleep / unavailable, capture still tries direct fetch + canvas paint ✓

---

## v0.1.5 — 2026-05-15

Fixes for the three biggest fidelity gaps users were hitting: images, SVG, and grid containers.

### Fixed

- **CSS Grid containers now use Figma auto-layout with wrap.** Was: grid treated as a block, children fell out of flow and ended up absolutely positioned, leaving huge empty sections. Now: `display: grid` triggers HORIZONTAL auto-layout, and when there are more children than columns (multi-row grid), `layoutWrap = 'WRAP'` is enabled. Counter-axis spacing comes from row-gap. Reads `grid-template-columns` (including `repeat(N, ...)` shorthand) to detect column count. `grid-auto-flow: column` triggers VERTICAL layout.
- **Multi-color SVGs no longer get clobbered by CSS color.** Was: the SVG color override applied my CSS `color` to every vector fill, wrecking logos that had explicit per-shape colors. Now: only overrides when the SVG source actually contains `currentColor`. Strokes that were currentColor also get recolored.
- **External SVG via `<img src="x.svg">` becomes editable vectors.** Was: rasterized to PNG, looked blurry, not editable. Now: capture fetches the SVG source via `fetch()` (or decodes data: URIs) and stores `tn.svg.source`, so the plugin's vector path runs. Falls back to raster only if the fetch fails or CORS blocks it.
- **CSS `object-fit` mapped to Figma image scale modes.** `contain` → FIT, `cover` → FILL (default), `none` → CROP, `scale-down` → FIT. Previously everything was FILL, which cropped tall images badly.
- **CSS `flex-grow` and `align-self` honored per child.** Was: all flex children got the parent's `align-items` setting. Now: each child's own `align-self` is mapped to `layoutAlign` (stretch / center / min / max), and `flex-grow > 0` sets `layoutGrow` on that child specifically.

### Capture additions

- Captures `flex-grow`, `flex-shrink`, `flex-basis`, `align-self`, `grid-template-columns`, `grid-template-rows`, `grid-auto-flow`, `object-fit`, `object-position`.

### Verified live in real Figma

- `repeat(3, 1fr)` with 6 children → HORIZONTAL wrap auto-layout, cols=3, wrap=true ✓
- `1fr 1fr 1fr 1fr` with 8 children → HORIZONTAL wrap auto-layout, cols=4 ✓
- `grid-auto-flow: column` → VERTICAL layout ✓
- 6-card grid actually renders as a 2D wrap layout with correct gaps ✓
- currentColor SVG → recolored to CSS color ✓
- Multi-color SVG (red + green circles) → original colors preserved ✓

---

## v0.1.4 — 2026-05-15

Direct HTML file upload — no Chrome extension required for self-contained HTML files.

### Added

- **Drop a `.html` file directly into the Figma plugin.** The plugin loads it into a hidden iframe at your chosen render width, waits for fonts to settle, walks the DOM, and runs the same import pipeline as a Chrome-captured `.wsnap` file.
- **Render width selector** for HTML uploads (1920 / 1440 / 1024 / 768 / 390).
- **HTML upload accepts the same file types in the drop zone**: `.wsnap`, `.json`, `.html`, `.htm`.

### Notes

- HTML uploads work best with self-contained files: inline `<style>`, data: URI images, no external dependencies. Files referencing local CSS/images via relative paths can't be resolved (the iframe has no filesystem access).
- External CDN resources (fonts, CSS, images) may load if the Figma plugin sandbox allows them and CORS is friendly.
- For full fidelity with live pages, prefer the Chrome extension path.

### Verified

- Synthetic HTML with hero + heading + paragraph + button renders to 5 wsnap nodes ✓
- Flex layout detected ✓
- Linear gradient extracted ✓
- Text content preserved ✓
- Output structure compatible with the existing renderer (no separate code path on the Figma side) ✓

---

## v0.1.3 — 2026-05-15

Major fidelity upgrade: SVG icons are now editable vectors, CSS rotation and filter effects render correctly, font fallback is smarter.

### Added

- **Editable SVG vectors.** Previously SVG icons came in as raster images. Now uses `figma.createNodeFromSvg` (with async fallback) to produce real `VECTOR` nodes you can edit, recolor, and reshape. CSS `color` on the SVG element is honored as a fill override (handles `currentColor`-style icons).
- **CSS `transform: rotate()` → Figma `node.rotation`.** Supports `deg`, `rad`, `turn`, `grad`, and also extracts rotation from `matrix(...)` shorthand. Direction flipped (CSS clockwise = Figma counter-clockwise).
- **CSS `filter: drop-shadow()` → Figma DROP_SHADOW effect.** Was previously silently ignored. Glows (large blur + zero offset) and stylized shadows now render. Multiple drop-shadows in one filter string supported.
- **CSS `filter: blur()` → Figma LAYER_BLUR effect.** Blurred panels, frosted-glass effects, hero overlays now render.
- **Font family chain iteration.** Was: take the first family in the CSS list and that's it. Now: try EVERY family in the list at the requested weight, then every family at Regular, then Inter at the requested weight, then Inter Regular. So `"Sohne", "Inter", system-ui, sans-serif` correctly falls through to Inter when Sohne isn't installed.

### Verified live in real Figma

- SVG with circle + checkmark → FRAME containing 2 editable VECTOR nodes ✓
- `rotate(45deg)` → node.rotation = -45 ✓
- `rotate(0.5turn)` → node.rotation = -180 ✓
- `matrix(0.707, 0.707, -0.707, 0.707, 0, 0)` → node.rotation ≈ -45 ✓
- `drop-shadow(0px 0px 30px rgba(99,102,241,0.8))` → DROP_SHADOW effect with correct color, blur, offset ✓
- `blur(8px)` → LAYER_BLUR radius 8 ✓
- Font chain: `"Sohne", "Inter", system-ui` → uses Inter Regular when Sohne missing ✓
- Font chain: `Poppins, sans-serif` (Poppins installed) → uses Poppins Bold for weight 700 ✓
- Missing fonts reported: `["Sohne|Regular"]` ✓

---

## v0.1.2 — 2026-05-15

Post-real-import fidelity pass after seeing the first divriots.com render.

### Fixed

- **Letter-spacing in `em` and `rem` was ignored.** Sites like divriots use `letter-spacing: -0.03em` heavily. Now converted to pixels using the element's `fontSize` (or 16 for rem). Also accepts `%` and numeric values.
- **Line-height in `em` and `rem` was ignored.** Same fix as letter-spacing.
- **Gap shorthand was parsed wrong on one axis.** CSS `gap: 32px 64px` means row-gap 32, column-gap 64. The parser used `parseFloat` which always picked 32, so horizontal flex rows had wrong spacing. Now axis-aware: horizontal uses column-gap, vertical uses row-gap.
- **Bold text fell back to Regular when the family was missing.** Now the fallback chain is family/style → family/Regular → Inter/style → Inter/Regular. So a bold heading in an unavailable font stays bold via Inter Bold instead of getting flattened to Regular.

### Added

- **Missing-font report.** When fonts fail to load, the plugin lists them in the import toast and notifies. So you know exactly which fonts to install in your OS to get full fidelity.
- **`flex-wrap: wrap` support** via Figma's `layoutWrap = 'WRAP'` and `counterAxisSpacing`. Wrapped flex layouts now render with the correct row-spacing.

### Verified live in Figma

- Gap `'32px 64px'` with horizontal layout → 64 (column gap) ✓
- Gap `'32px 64px'` with vertical layout → 32 (row gap) ✓
- Letter-spacing `-0.05em` with fontSize 64 → -3.2px ✓
- Letter-spacing `0.1rem` → 1.6px ✓

---

## v0.1.1 — 2026-05-15

Sandbox-compatibility + layout-fidelity pass after live testing in real Figma.

### Fixed

- **Plugin failed to load with "Unexpected token ." error.** Figma's plugin sandbox doesn't accept optional chaining (`?.`) or nullish coalescing (`??`). Replaced all instances with explicit null checks. Also transpiled the whole `code.js` to ES2017 with Babel as a belt-and-suspenders defense.
- **Plugin failed to load with "Unexpected token {" error.** Figma's plugin sandbox doesn't accept optional catch binding (`catch {}` without a parameter). All catches now bind the error.
- **Auto-layout frames collapsed to hug their children.** A header with `display: flex; justify-content: space-between` and a captured width of 1100px came out as 357px (sum of children widths). The two ends never spread apart. Fix: capture the frame's original size before turning on `layoutMode`, then immediately set both `primaryAxisSizingMode` and `counterAxisSizingMode` to `FIXED` and resize back to the captured dimensions.
- **Text nodes rendered 2–3x too tall.** Setting `textAutoResize = 'HEIGHT'` ignored the captured pixel height; 20px nav links rendered at 48px, breaking nav row alignment. Fix: when the captured rect height is at least 80% of the font size (true for any real rendered text), use `textAutoResize = 'NONE'` and resize to exact captured dimensions. Falls back to auto-height only for implausibly small captured heights.
- **Layered backgrounds parsed wrong.** A CSS `background-image: url(x.png), linear-gradient(...)` either dropped the image or broke the gradient parser. Now splits by top-level comma and handles each layer independently.
- **Multibyte SVG bytes were corrupted.** Inline `<svg>` data with non-ASCII content (foreign-language text, em-dashes, special symbols) became garbage bytes. Now uses `TextEncoder` for UTF-8 safe encoding, with a manual fallback.
- **Flex/grid containers were mis-detected as inline text containers** when all children were inline elements like `<a>`. Now correctly treated as layout containers and translated to Figma Auto Layout.
- **Position-absolute children inside auto-layout parents** weren't taken out of flow. Now correctly set `layoutPositioning = 'ABSOLUTE'` with explicit x/y.

### Added

- oklch / oklab color parsing (Tailwind v4 colors).
- Dashed / dotted border style approximation via `dashPattern`.
- Text-leaf elements with bg color, image, gradient, border, or shadow are now wrapped in a styled frame so the visual styling renders alongside the text.
- Border-style respected — `border-style: none` no longer renders a stroke even if `border-width` has a value.
- `display: contents` elements flatten correctly instead of collapsing children into text.
- Form input values and placeholders captured.
- Multiple box shadows + inset shadows.
- `aria-pressed` on toggle buttons in the extension popup.

### Verified

- 46 / 46 unit tests pass.
- Full end-to-end test with a synthetic page (JSDOM → capture → import) passes with 0 errors.
- Live test in real Figma (file `dc7YwMwKdG7SYtK74nMwFu`) with the real divriots.com capture renders header, nav with SPACE_BETWEEN, hero section with VERTICAL center auto-layout, absolute-positioned background overlays, linear gradient fills, and opacity. Captured positions match Figma output to within rounding error.

---

## v0.1.0 — 2026-05-15

Initial release.

- Chrome extension (MV3): popup UI, capture engine, background worker.
- Figma plugin: drop-zone + paste UI, full rendering pipeline.
- Supports text, images, backgrounds, borders, radii, shadows, gradients, opacity, flex → auto-layout, multi-viewport, full-page scroll capture.
