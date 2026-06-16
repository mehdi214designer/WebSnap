# WebSnap

A free, faster, cleaner alternative to html.to.design.

Capture any webpage from Chrome, import it into Figma as editable layers. No paywall, no relay server, no account.

Built for the WPMN design team. Open to anyone.

**Current version:** v0.4.5 — Wider Auto Layout coverage plus the cover-art text. Flex/grid containers always become Auto Layout now (geometry spacing stops them collapsing) and clean block stacks do too, so the center column stops importing as a plain frame. Only containers Auto Layout can't represent (clipped scrollers/marquees) stay pixel-perfect absolute. 90 Auto Layout containers on the AERA page, 12px worst-case drift. Also: SVGs with baked-in `<text>` (the cover-art "Breathe") render from the rasterized fallback so the font doesn't substitute and wrap. Render-side, reload and re-import. v0.4.4 — Auto Layout rebuilt to be faithful. It used to read CSS `gap`/`justify-content` and collapse pages whose spacing comes from margins. Now spacing, padding, and alignment are measured straight from the captured child positions (ground truth), and containers that a single spacing can't represent fall back to pixel-perfect absolute so nothing collapses. Render-side, so reload the plugin and re-import. v0.4.3 — Two render fixes from a real AERA Music (MagicPath) capture: loose labels sitting next to an icon (left-nav items, mood pills) no longer get dropped, and single-line text no longer breaks mid-word when the font is substituted ("Breathe" was rendering as "Brea/the"). Both are render-side, so just reload the Figma plugin and re-import your existing `.wsnap`. v0.4.2 — More fixes from a real jimo.ai (Framer) capture: infinite logo marquees no longer fast-forward off-screen (they reset to rest position), and collapsed accordion answers no longer render on top of their questions. v0.4.1 fixed inline (`data:` URI) images reused in multiple places losing their asset id. Built on the v0.4.0 universality pass: works on any site or dashboard, not just hand-built marketing pages. Icon fonts (Font Awesome / Material Symbols / etc.) rasterize instead of dropping, decorative `::before`/`::after` backgrounds come through as layers, and native checkboxes/radios render as proper controls instead of junk. Built on the v0.3.0 product-quality pass (clean layer trees, semantic names, no-freeze reliability), real viewport resizing + inline text runs + capture persistence (v0.2.0), full CSS coverage (v0.1.18), WebP→PNG (v0.1.16), and everything before. See CHANGELOG.md for the full history and coverage matrix.

> **Note:** Capture-side fixes (images, scroll, lazy-load) need a re-capture. Render-side fixes (layout, carousel, fonts, colors) only need a plugin reload + re-import of the existing `.wsnap`.

## What's inside

```
WebSnap/
├── chrome-extension/   Load this into Chrome
├── figma-plugin/       Load this into Figma
├── README.md           This file
└── INSTALL.md          Step-by-step setup
```

## Quick install

**Chrome:**

1. `chrome://extensions` → Developer mode on → Load unpacked → pick `chrome-extension/`

**Figma:**

1. Plugins → Development → Import plugin from manifest → pick `figma-plugin/manifest.json`

Full walkthrough in `INSTALL.md`.

## Workflow

```
1. Chrome page → Click WebSnap icon → Capture → Download .wsnap
2. Figma → Run WebSnap plugin → Drop .wsnap → Import
3. Your page lands as an editable Figma frame
```

## What works in v0.1

- Full-page DOM capture with positions and sizes
- Text with fonts, weights, sizes, colors, line height, letter spacing, alignment, transforms, decorations
- Backgrounds: solid colors, linear gradients (including oklch / oklab from Tailwind v4), images
- Layered backgrounds (gradient + image on the same element)
- Borders: width, color, radius, dashed/dotted style hint
- Box shadows: outer and inset, multiple shadows
- Opacity, overflow clipping
- Flexbox containers translated to Figma Auto Layout
- Absolute / fixed children correctly opt out of Auto Layout flow
- Form input values and placeholders
- Multiple viewports (1920, 1440, 1024, 768, 390, current)
- Local files only. Your captures never leave your machine.

## What's rough

- SVG icons are imported as raster images (not editable vectors). Icon-font glyphs (Font Awesome, Material Symbols, etc.) are rasterized as of v0.4.0.
- Only background `::before`/`::after` are captured (color, gradient, `url()` image). Text-content pseudos are skipped.
- Native checkbox/radio are synthesized as a styled box/circle, not pixel-exact OS rendering.
- Shadow DOM and iframes are skipped.
- CSS animations are forced to their end state, then captured as static. Masks and clip-path are skipped.
- CSS Grid layouts use absolute positioning instead of grid auto layout.
- `position: sticky` treated as in-flow.

## Can't be captured (hard limits)

- WebGL / 3D canvas content (not in the DOM as styled boxes)
- Cross-origin video frames
- Content that only appears after a user interaction (hover menus, modals you didn't open)

2D canvas (charts) does capture via `toDataURL`.

## Roadmap (when there's time)

- True SVG path import (Figma's `createNodeFromSvg`)
- CSS grid → Figma layout grid
- Shadow DOM traversal
- `position: sticky` rendered as pinned in Figma
- Chrome device emulation via `chrome.debugger` API for accurate viewport switching
- Direct Figma upload via the MCP plugin model

## File format

WebSnap files use the `.wsnap` extension. It's plain JSON with base64-inlined assets. You can open one in a text editor.

```json
{
  "version": "0.1",
  "url": "https://example.com",
  "title": "Page title",
  "viewport": { "width": 1440, "height": 900 },
  "document": { "width": 1440, "height": 3200 },
  "captured_at": "2026-05-15T10:00:00.000Z",
  "tree": { ... },
  "assets": { "asset_1": "data:image/png;base64,..." },
  "stats": { "nodes": 432, "images": 18 }
}
```

## Dev notes

- The Chrome extension is plain MV3. No build step. Edit any file, hit refresh on the extension page.
- The Figma plugin is plain JS. No build step. Edit `code.js` or `ui.html`, re-run the plugin.
- Color parsing supports hex, rgb, rgba, hsl, hsla, oklch, oklab, named colors.
- Image fetching tries CORS fetch first, falls back to canvas-paint, downscales anything over 4 MB.
- Tests live in the project's parent `outputs/` folder during dev (parser unit tests and a JSDOM e2e test). They pass 46/46 plus end-to-end at last build.

## Credits

Built by Mhasan with Claude. For the WPMN design team. MIT for internal use.
