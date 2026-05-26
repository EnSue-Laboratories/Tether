---
name: tether
description: Read the browser's console and network activity via the `tether` CLI instead of asking the human to capture it. Use when debugging a web app — checking for console errors, finding failed or slow network requests, or inspecting a specific request/response after a page action.
---

# Tether — browser console & network for the agent

`tether` exposes the live browser console + network logs that the Tether extension is capturing.
Reach for it whenever you're working on a web app and would otherwise ask the human "what does the
console say?" or "what did that request return?".

## When to use
- After you navigate or trigger an action and want to know if the page logged **errors/warnings**.
- To find **failed (4xx/5xx) or slow** network requests behind a bug.
- To inspect **one request's** headers / status / (captured) body.
- To get a **clean baseline**: `tether clear` before a repro, then read what the repro produced.

## First check
Run `tether status` first. If it exits non-zero:
- `3` → the daemon isn't running. Ask the human to start `tetherd` (or launch the browser with the
  extension, which starts it via Native Messaging).
- `4` → no browser/extension connected, or capture is toggled off. Ask the human to open the page
  and enable capture in the Tether extension.

## Common commands
```sh
tether status                      # daemon/extension/sessions + capture state
tether sessions                    # list active tabs/sessions (pick a --session id)

tether console --level error,warn --since 2m     # recent errors/warnings
tether console --grep "checkout" -n 50           # filter console text

tether net --status 5xx --since 5m               # recent server errors
tether net --status 4xx --type xhr,fetch         # failed API calls
tether get <requestId> --headers --body          # full detail of one request

tether clear                                     # reset before a clean repro
tether export --format har -o session.har        # full network export (HAR)
```
Add `--json` to any read command for JSONL output you can parse; default is a human table.
Most commands default to the most recently active session — pass `--session <id>` to target another.

## Typical workflow
1. `tether clear` to start clean.
2. Have the human (or your own browser automation) reproduce the issue.
3. `tether console --level error --since 1m` and `tether net --status 5xx,4xx --since 1m` to see what broke.
4. `tether get <requestId> --body` to drill into the offending request.

## Security
Console/network logs can contain tokens, cookies, and PII. Tether redacts known sensitive headers
(`authorization`, `cookie`, …) by default and keeps request bodies off unless enabled — but still
**do not paste raw `tether` / `tether export` output into shared channels**. Summarize findings
(status codes, error messages, the failing URL) instead of dumping full logs.
