# Contributing to WebSnap

Want to fix a bug or add a feature? Cool.

## Dev setup

There's no build step. The Chrome extension and Figma plugin are plain JS — edit a file, reload.

**Chrome:**

1. Clone the repo
2. `chrome://extensions` → Developer mode on → Load unpacked → pick `chrome-extension/`
3. Edit any file, click the refresh icon on the WebSnap card to pick it up
4. For local HTML pages, also flip **Allow access to file URLs** on the extension card

**Figma:**

1. Plugins → Development → Import plugin from manifest → pick `figma-plugin/manifest.json`
2. Edit `code.js` or `ui.html`, re-run the plugin

## Testing

The `test-pages/` folder has stress-test HTML pages covering grid/flex, dark/glass, typography, tables/forms, effects + pseudo-elements, and other hard cases. Capture each, drop the `.wsnap` into the Figma plugin, and compare against the source.

For real-world testing, capture public landing pages and check fidelity against the live site.

## Filing an issue

Include:

- What you captured (URL or attach the page HTML)
- What you expected
- What you got (Figma screenshot helps a lot)
- The `.wsnap` file if possible — it's plain JSON, you can drop it straight in

## Submitting a PR

1. Fork, branch from `main`
2. Bump the version in `chrome-extension/manifest.json` if it's a user-facing change
3. Add an entry at the top of `CHANGELOG.md`: what changed, why, and before/after where useful
4. Open the PR with a clear description and a screenshot or `.wsnap` if relevant

## Code style

Plain JS, no build, no transpile. Match the style of the file you're editing. Comments should explain WHY, not WHAT — the code already says what.

## What's in scope

- Better fidelity (icons, gradients, layout, text, motion → static)
- More CSS coverage (mask, clip-path, true grid, etc.)
- Better SVG handling (vectors > raster)
- More resilient image fetching
- Faster captures, smaller `.wsnap` files

## What's out of scope (for now)

- A relay server or cloud upload — captures stay on your machine, by design
- Account / login / sync — same reason
- A rewrite to TypeScript / a build pipeline — plain JS keeps the contribution barrier low

If you want to do something in the out-of-scope list, open an issue first so we can talk.
