# Tether extension (Phase 0 skeleton)

MV3 Chrome extension that captures console + network via the `chrome.debugger` (CDP) API and streams
events to the local `tetherd` daemon over Native Messaging. UI is English-only and minimal
(connection status, capture toggle, current tab/session, recent counts).

> Phase 0 = structure + stubs. Capture/UI logic is filled in after the daemon lands; see
> `../docs/DESIGN.md` for the event schema (§2), Native Messaging protocol (§3), and security (§6).

## Layout
- `manifest.json` — MV3 manifest (`debugger` + `nativeMessaging` permissions).
- `src/background.ts` — service worker: Native Messaging port + per-tab debugger attach/detach.
- `src/capture.ts` — CDP → Tether event mapping + header/body redaction.
- `popup/` — minimal English popup UI.

## Build & load (once implemented)
```sh
# TypeScript → JS (esbuild/tsc) into the files manifest.json references (background.js, popup/popup.js)
npm install && npm run build
# Then: chrome://extensions → Developer mode → Load unpacked → select this folder.
```

## Native messaging host
The extension connects to native host **`com.ensue.tether`**. The `tetherd` side installs the host
manifest (pointing Chrome at the daemon binary and allowlisting this extension id) — owned by the
daemon implementation.

> Note: capturing via `chrome.debugger` shows Chrome's "Tether started debugging this browser"
> banner; expected for a devtools-class extension. Capture is opt-in (off until toggled).
