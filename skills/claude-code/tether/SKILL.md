---
name: tether
description: Read the browser's console and network logs through the `tether` CLI instead of asking the human to capture them. Use when debugging a web app — checking for console errors, finding failed or slow network requests, or inspecting a specific request/response after a page action. Sets Tether up if it is not installed yet.
metadata:
  { "openclaw": { "emoji": "🪢", "os": ["linux", "darwin"], "requires": { "bins": ["tether"] } } }
---

# Tether — browser console & network for the agent

`tether` surfaces the live browser console + network activity that the Tether extension captures, so
you can see what the page did instead of asking the human "what does the console say?" or "what did
that request return?". Reach for it whenever you're debugging a web app.

## First: is it set up?
Run `tether status`:
- **command not found** → not installed; do **Setup** below.
- **exit 3** (daemon not running) → the extension hasn't launched it. Ask the human to load the
  extension and enable capture (Setup steps 4–5). For a browser-less dry run: `tether daemon --no-native`.
- **exit 4** (no extension connected) or **ok** → ready; go to **Use**.

## Setup (first time on a machine)
Needs **Rust 1.95+**, Node/npm, and Google Chrome/Chromium. From a clone of
`EnSue-Laboratories/Tether`:
```sh
# 1. daemon/CLI (Rust 1.95+ for Cargo.lock v4; prefer rustup cargo if the system one is older)
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release
# 2. extension
cd extension && npm install && npm run build && cd ..
# 3. register the native-messaging host (creates the tetherd symlink + Chrome manifest)
./target/release/tether install-host
# 4. put tether on PATH (optional but convenient)
ln -sf "$PWD/target/release/tether" "$HOME/.local/bin/tether"   # ensure ~/.local/bin is on PATH
```
Steps 1–4 are **agent-automatable**. The last bit needs the **browser UI (a display)**:
5. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`.
   Confirm the id is `lcbgiapgidfgdaohjbofohaokokcpefd` (matches the native-host allowlist).
6. Open the page, click the **Tether** toolbar icon → **Start capturing this tab** (shows Chrome's
   "started debugging this browser" banner — expected).

See `docs/RUNBOOK.md` in the repo for the full walkthrough.

## Use
Default output is a human table; add `--json` for JSONL you can parse. Read commands take
`--session <id>` / `--tab <id>` (default: most recently active) and `--since <dur>` (`30s`/`5m`/`1h`).
```sh
tether status                                  # daemon/extension/sessions + capture state
tether sessions                                # active tabs/sessions (pick a --session id)
tether console --level error,warn --since 2m   # recent console errors/warnings
tether console --grep checkout -n 50
tether net --status 5xx --since 5m             # recent server errors
tether net --status 4xx --type xhr,fetch       # failed API calls
tether get <requestId> --headers               # full detail (all phases) of one request
tether clear                                   # reset before a clean repro
tether export --format json -o session.json    # export the session
```
Exit codes for branching: **3** daemon down, **4** extension not connected, **5** no matching session.

### Typical workflow
1. `tether clear` to start clean.
2. Reproduce the issue (human, or your own browser automation).
3. `tether console --level error --since 1m` and `tether net --status 5xx,4xx --since 1m`.
4. `tether get <requestId> --headers` to drill into the failing request.

## Security
Console/network logs can contain tokens, cookies, and PII. Tether redacts sensitive headers
(`authorization`/`cookie`/…) in the extension before events leave the browser, and request bodies are
off by default — but still **summarize findings (status codes, error text, failing URL) rather than
pasting raw `tether` / `tether export` output into shared channels**.
