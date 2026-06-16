# WebSnap — Install Guide

Two pieces. Both install locally in dev mode. Five minutes total.

## 1. Chrome extension

1. Open Chrome → `chrome://extensions`
2. Top-right, switch on **Developer mode**
3. Click **Load unpacked**
4. Select the `WebSnap/chrome-extension` folder
5. (Optional) Pin the extension to your toolbar so the icon is one click away

To update later: hit the refresh icon on the WebSnap card on the extensions page.

## 2. Figma plugin

1. Open Figma. Any design file works.
2. Menu (top-left in desktop app, hamburger in web): **Plugins → Development → Import plugin from manifest...**
3. Pick `WebSnap/figma-plugin/manifest.json`
4. Run anytime: **Plugins → Development → WebSnap**

To update later: just re-run, it picks up the latest code.

## Capture flow

1. Open Chrome to whatever page you want
2. Resize Chrome to your target width (1440, 1920, 768, whatever). The capture uses the current viewport.
3. Click the WebSnap toolbar icon
4. Pick capture mode and theme
5. Hit **Capture**
6. When done, either:
   - Click **Download .wsnap** (saves to your Downloads)
   - Click **Copy to clipboard**

## Import flow

1. In Figma, run WebSnap from Plugins menu
2. Either:
   - Drag the .wsnap file onto the drop zone
   - Or click the paste tab, paste the JSON
3. Hit **Import to canvas**
4. Wait for the progress bar
5. The page appears as a Frame in the center of your viewport

## Troubleshooting

**Capture button does nothing on chrome:// or extension pages.**
Chrome blocks scripts on its internal pages. Switch to a real http/https page.

**Images are missing.**
Some sites send CORS headers that block cross-origin image fetches. WebSnap tries hard, but if a host refuses, the image will be a gray placeholder. Workaround: open the image in a new tab first so it's cached and CORS-friendly, then re-capture.

**Fonts look wrong in Figma.**
Figma only renders fonts you have installed. If a site uses a font you don't have, WebSnap falls back to Inter at the closest weight. Install the font in your OS, restart Figma, re-import.

**Plugin won't load: "Plugin code error".**
Open the Figma dev console: **Plugins → Development → Open Console**. The error message tells you what's wrong. Most commonly: malformed JSON in the .wsnap file. Re-capture and try again.

**Layers look misaligned.**
Some layouts use CSS grid or absolute positioning that doesn't map cleanly. Turn off the "Use Auto Layout" toggle in the plugin and re-import. Pure absolute positioning is more forgiving.

**Empty layers / nothing happens.**
Make sure the file is a real WebSnap export. Open it in a text editor — it should start with `{"version":"0.1"`. If you pasted from clipboard and got garbage, the page may not have had focus when you copied.

## Known limits in v0.1

- SVG icons are imported as raster images (not editable vectors)
- Shadow DOM and iframes are skipped
- CSS animations, masks, clip-path are skipped
- CSS Grid layouts are positioned absolutely (no grid auto layout)
- Pseudo-elements (`::before`, `::after`) are skipped
- Very large pages (5000+ nodes) may slow down the import

These are on the roadmap.
