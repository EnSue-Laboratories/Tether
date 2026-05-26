# Tether — end-to-end runbook

How to build, install, and verify the full path: **browser → extension → daemon → CLI**. The
extension id is fixed to `lcbgiapgidfgdaohjbofohaokokcpefd` (via the `key` in `extension/manifest.json`),
so the native-host allowlist matches on every machine.

## 1. Build the daemon/CLI
Requires **Rust 1.95+** (the `Cargo.lock` is v4). If you have rustup, put it first on PATH:
```sh
export PATH="$HOME/.cargo/bin:$PATH"   # if the system cargo is older than 1.78
cargo build --release                   # produces target/release/tether
```

## 2. Build the extension
```sh
cd extension
npm install && npm run build            # produces background.js + popup/popup.js
```

## 3. Install the native-messaging host
Lets Chrome launch the daemon when the extension connects. Either:
```sh
target/release/tether install-host                # official CLI entry, resolves its own path
# or:
native-host/install.sh target/release/tether      # transparent fallback script
```
This writes `com.ensue.tether.json` into Chrome's `NativeMessagingHosts/` dir and creates a
`tetherd` symlink next to the binary (the daemon enters native-host mode only when argv0 ends with
`tetherd`).

## 4. Load the extension
`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/`
folder. Confirm the id is `lcbgiapgidfgdaohjbofohaokokcpefd` (must match the host manifest's
`allowed_origins`).

## 5. Capture and verify
1. Open the page you want to observe (any site, or a test page that logs to console and makes
   fetch/XHR calls).
2. Click the **Tether** toolbar icon → **Start capturing this tab**. Chrome shows a "Tether started
   debugging this browser" banner (expected — capture uses `chrome.debugger`/CDP). This also launches
   the daemon via native messaging.
3. In a terminal, read the events:
   ```sh
   tether status                      # daemon up + extension connected
   tether sessions                    # the captured tab's session id
   tether console --level error --since 1m
   tether net --status 5xx,4xx --since 1m
   tether get <requestId> --headers
   tether clear                       # reset before a clean repro
   ```
   `--json` on any read command gives JSONL for tools/agents.

## Notes & gates
- **Real GUI required for the popup-driven flow above.** This is the human/display gate — a headless
  box has no toolbar to click. A headless automated smoke (puppeteer: load the extension, open the
  popup page, click the toggle, drive a page, then read via CLI) is a possible follow-up.
- **Exit codes** (for scripting the agent): `3` daemon not running, `4` extension not connected,
  `5` no matching session.
- **Security**: sensitive headers (`authorization`/`cookie`/…) are redacted in the extension before
  events leave the browser; request and response bodies are captured by default and size-capped.
  Treat exports as sensitive local artifacts and summarize findings rather than pasting raw
  `tether export` output into shared channels.
- **Already verified at the CLI seam** (no browser needed): feeding the daemon Native-Messaging-framed
  events in the extension's exact schema and reading them back through every CLI command (incl.
  daemon-stamped `seq` and the `3`/`5` exit codes). The remaining unverified link is real Chrome CDP
  capture → native messaging, which step 5 exercises.
