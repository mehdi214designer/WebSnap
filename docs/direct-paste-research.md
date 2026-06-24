# Direct copy-to-Figma without the plugin — research spike

**Status:** spike only, no implementation. Decision pending.

## Goal

Today's flow: capture in Chrome → download `.wsnap` → open the Figma plugin → drop the file → wait for the build. Three discrete steps.

Target flow: capture in Chrome → switch to Figma → `Cmd+V` → editable layers paste in. Two steps, no plugin window.

## Three paths investigated

### 1. Replicate Figma's internal clipboard format

When you copy any layer in Figma, it writes a proprietary payload to the OS clipboard alongside the standard image/text fallbacks. Pasting in Figma reads that payload back as native nodes.

**Reverse-engineering it:** the format is an opaque blob with a versioned protobuf-like structure. It's not documented anywhere on Figma's site and there's no SDK access to it. A few open source projects (html.to.design's own browser preview, some Figma-to-Sketch converters) have done partial reverse-engineering with mixed results — Figma has shipped breaking changes to the format multiple times.

**Pros:** the fastest UX (real Cmd+V paste, no plugin run).

**Cons:**

- The format isn't public. Every Figma update can break us.
- Legal gray area — circumventing Figma's plugin model by spoofing their internal IPC.
- Hard to debug when it breaks (no error messages, paste just silently fails).
- A community project shouldn't ship something this fragile.

**Verdict:** Don't pursue.

### 2. Figma REST API — create nodes directly in a target file

Figma exposes a real REST API. With a personal access token (PAT) or OAuth, you can read a file and create nodes inside it.

**Workflow:** extension asks the user once for a Figma PAT, stores it, asks for a target file URL. After capture, extension calls `POST https://api.figma.com/v1/files/:key/...` and writes the layers directly. The user switches to that Figma file and sees the import already there.

**Pros:**

- Public, documented API. Stable.
- No plugin window required.
- Same target file every session = no friction after first setup.

**Cons:**

- The REST API's write surface is actually more limited than the plugin API. It supports creating frames, rectangles, text, and basic vectors, but doesn't expose every Figma feature the plugin API does (some Auto Layout properties, some effects, some constraint behaviors). Fidelity would step backward from the current plugin.
- Latency: every node = one API call (or batch). A 1,200-node page = noticeable wait, especially on slow networks.
- The user has to manage a PAT, which is a friction point most designers won't accept.
- Rate limits exist (different per plan).
- Token storage in a Chrome extension is a security trade-off — best practice is to use chrome.storage with the user understanding the risks.

**Verdict:** Viable, but lower fidelity and worse UX than the current plugin. Not a clear win.

### 3. Hybrid — clipboard payload + plugin reads on paste

Extension writes the `.wsnap` JSON to the clipboard as `text/plain` or a custom MIME. User switches to Figma, opens the WebSnap plugin (one click), and the plugin reads from clipboard automatically and starts the import — no file drop needed.

**Pros:**

- No new APIs, no auth, no PAT.
- Uses everything that already works (the plugin's import path is unchanged).
- One-click vs the current three-step.

**Cons:**

- Still requires the user to open the plugin window. Not the "Cmd+V" magic of path 1.
- Big captures may exceed clipboard size limits (typically 5–10 MB on most OSes for text).

**Verdict:** Lowest-effort, lowest-risk, modest UX improvement. Realistic next ship.

## Recommendation

**Skip paths 1 and 2 for now. Implement path 3 as a small follow-up.** Specifically:

1. Chrome extension: after capture finishes, add a "Copy to clipboard" button next to "Download .wsnap". On click, write `JSON.stringify(result)` to the clipboard via `navigator.clipboard.writeText`.
2. Figma plugin (ui.html): the existing **Paste** tab already accepts a pasted `.wsnap` JSON. Keep that working. Optionally, on plugin open, auto-read the clipboard if it looks like a wsnap (`{ "version": "0.4` prefix). Show a one-click "Import from clipboard" button.

That gets the user from three steps to two steps without any reverse-engineering.

If we later want the true Cmd+V experience, path 1 is the only way and we should wait until Figma publicly documents a clipboard API (they're slowly opening up — they shipped a plugin clipboard API in 2024 that didn't exist before). Until then, path 3 is the pragmatic answer.

## Open questions

- Clipboard payload size — what's the largest `.wsnap` we've seen? FluentMembers was 3.9 MB. Some clipboards cap at 5 MB. Need to test or fall back to file.
- Should the auto-read-clipboard behavior be opt-in (paranoid users don't want a plugin reading their clipboard) or opt-out?

## Next step

When ready: spike path 3 in a feature branch. Time-box to 2 hours. If it works cleanly, ship behind a flag.
