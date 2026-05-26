# Tether extension (Phase 0 skeleton)

MV3 Chrome extension that captures console + network via the `chrome.debugger` (CDP) API and streams
events to the local `tetherd` daemon over Native Messaging. UI is English-only and minimal
(connection status, capture toggle, current tab/session, recent counts).

> Capture + UI are implemented against the merged contract (`../docs/DESIGN.md` §2 schema, §3.1
> Native Messaging, §6 security). End-to-end requires the `tetherd` daemon + native-host manifest
> (Codex) to receive events; until then the extension type-checks, builds, and loads, and capture
> attaches, but events have no daemon to land in yet.

## Layout
- `manifest.json` — MV3 manifest (`debugger` + `nativeMessaging` permissions).
- `src/background.ts` — service worker: Native Messaging port + per-tab debugger attach/detach.
- `src/capture.ts` — CDP → Tether event mapping + header/body redaction.
- `popup/` — minimal English popup UI.

## Build & load
```sh
npm install
npm run typecheck      # tsc --noEmit (strict)
npm run build          # esbuild: src/background.ts → background.js, popup/popup.ts → popup/popup.js
# Then: chrome://extensions → Developer mode → Load unpacked → select this folder.
```
Build outputs (`background.js`, `popup/popup.js`) are git-ignored — run `npm run build` after cloning.

## Native messaging host
The extension connects to native host **`com.ensue.tether`**. The `tetherd` side installs the host
manifest (pointing Chrome at the daemon binary and allowlisting this extension id) — owned by the
daemon implementation.

> Note: capturing via `chrome.debugger` shows Chrome's "Tether started debugging this browser"
> banner; expected for a devtools-class extension. Capture is opt-in (off until toggled).
