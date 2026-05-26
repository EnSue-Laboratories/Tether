---
name: tether
description: Use the Tether CLI to read browser console and network logs instead of asking the human to manually open DevTools, copy console output, or capture network requests. Use when debugging web apps, validating browser behavior, checking console errors/warnings, finding failed or slow requests, or inspecting one request/response after a page action.
---

# Tether

Tether exposes browser console and network activity captured by the Tether extension. Use it when a web debugging task depends on DevTools evidence.

## First Check

Run:

```sh
tether status
```

Handle failures by exit code:

- `3`: daemon/socket is unavailable. Ask the human to run `tether install-host`, reload the extension, or start `tether daemon --no-native` for local testing.
- `4`: no extension is connected or capture is off. Ask the human to open the target page and enable capture in the Tether extension popup.
- `5`: no matching session. Run `tether sessions` and pick a `--session`, or ask the human to refresh/reproduce with capture on.

## Common Commands

```sh
tether sessions
tether clear

tether console --level error,warn --since 2m
tether console --grep "checkout" -n 50 --json

tether net --status 5xx --since 5m
tether net --status 4xx --type xhr,fetch --json
tether net --url "/api/" --since 2m

tether get <requestId> --headers --body --json
tether export --format json -o tether-session.json
```

Use `--session <id>` when multiple tabs are active. Use `--json` when parsing output; stream commands emit JSONL.

## Clean Repro Workflow

1. Run `tether status` and confirm capture is connected.
2. Run `tether clear` before the repro.
3. Ask the human to perform the failing action, or trigger it with browser automation.
4. Run `tether console --level error,warn --since 2m`.
5. Run `tether net --status 4xx,5xx --since 2m`.
6. Inspect interesting requests with `tether get <requestId> --headers --body --json`.
7. Summarize the relevant URL, status, timing, console error, and likely cause.

## Privacy

Treat logs as sensitive. Tether redacts common secret headers by default, but console messages and bodies may still contain tokens, cookies, or PII. Do not paste raw `tether` output into shared channels unless the human explicitly asks. Summarize findings and quote only minimal sanitized snippets.

## Current Limits

- `export --format json` and `export --format har` are available.
- `watch` and config mutation are planned.
- Request/response bodies are captured by default, size-capped, and should be treated as sensitive.
