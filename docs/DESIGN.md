# Tether — Design (Phase 0)

Tether gives an AI agent the browser's **console** and **network** activity without the human
manually capturing it. This document is the contract the implementation builds against: the data
model, the extension↔daemon protocol, the `tether` CLI surface, buffering/limits, configuration,
and the security model.

Decision (kira): **CLI + Skill, no MCP.** A CLI works for every agent on the box (they all run a
shell); a `SKILL.md` teaches the agent *when/how* to use it. No MCP server/transport.

---

## 1. Architecture

```
┌─────────────────┐  Native Messaging  ┌──────────────────┐   local    ┌──────────────┐
│ Browser         │  (stdio, 4-byte    │ tetherd          │   query    │ tether CLI   │
│ extension (MV3) │  length-prefixed   │ (daemon /        │ ◀────────  │ (any agent / │
│  - console cap  │  JSON)             │  native host)    │            │  shell)      │
│  - network cap  │ ─────────────────▶ │  - per-session   │            └──────────────┘
│  - English UI   │                    │    ring buffers  │                   ▲
└─────────────────┘                    │  - query/export  │            ┌──────┴───────┐
                                        └──────────────────┘            │ SKILL.md     │
                                                                        │ (agent guide)│
                                                                        └──────────────┘
```

Three layers, one source of truth:

1. **Browser extension** (`extension/`, TypeScript, **English UI**). Captures console + network +
   tab/session metadata and pushes events to the daemon over Chrome Native Messaging. UI is minimal:
   connection status, capture toggle, current tab/session, recent event counts. No dashboard.
2. **`tetherd` daemon / native host** (Rust, single binary — *implemented by Codex*). Receives
   events from the extension, holds bounded per-session ring buffers, answers queries, exports.
   **The source of truth.**
3. **`tether` CLI** (Rust, same binary — *Codex*) + **`SKILL.md`** (this repo). The CLI is the
   agent-facing query surface; the Skill tells the agent when to reach for it.

Why a daemon at all: a browser extension is sandboxed and cannot be reached directly by a shell
agent, and it cannot open a listening socket. Native Messaging lets the browser launch `tetherd`
and exchange JSON over stdio; `tetherd` outlives individual CLI calls and holds the rolling buffer.

---

## 2. Data model (event schema)

All events are JSON objects with a common envelope. `ts` is Unix epoch milliseconds. `sessionId`
is a daemon-assigned id for one tab's lifetime (survives same-tab navigations until the tab closes);
`tabId` is Chrome's tab id. Field names are stable — the CLI `--json` output returns these verbatim.

### Common envelope
```jsonc
{
  "type": "console" | "network" | "session",
  "ts": 1716690000123,
  "tabId": 42,
  "sessionId": "s_01H...",
  "seq": 1024            // per-session monotonic sequence (ordering + cursors)
}
```

### Console event (`type: "console"`)
```jsonc
{
  "...envelope": "...",
  "level": "log" | "info" | "warn" | "error" | "debug",
  "text": "Uncaught TypeError: x is not a function",
  "args": ["...", 3, {"...": "..."}],   // structured args when serializable (size-capped)
  "stack": "at foo (app.js:12:5)\n...",  // present for error/trace
  "url": "https://app.example.com/checkout",
  "source": "console-api" | "exception" | "network-error"
}
```

### Network event (`type: "network"`)
One logical request emits a `request` phase and later a `response` (or `failed`) phase, correlated
by `requestId`. Bodies are **optional and size-capped** (see §5) and **redacted** (see §6).
```jsonc
{
  "...envelope": "...",
  "requestId": "r_5567",
  "phase": "request" | "response" | "failed",
  "method": "GET" | "POST" | ...,
  "url": "https://api.example.com/v1/cart",
  "resourceType": "xhr" | "fetch" | "document" | "script" | "image" | ...,
  "status": 503,                 // response/failed only
  "statusText": "Service Unavailable",
  "mimeType": "application/json",
  "requestHeaders": { "...": "..." },   // redacted
  "responseHeaders": { "...": "..." },  // redacted
  "requestBody":  { "truncated": false, "text": "..." },   // optional
  "responseBody": { "truncated": true,  "text": "...", "size": 184320 },  // optional
  "durationMs": 1843,
  "fromCache": false,
  "errorText": "net::ERR_CONNECTION_REFUSED"   // failed only
}
```

### Session event (`type: "session"`)
```jsonc
{
  "...envelope": "...",
  "event": "opened" | "navigated" | "closed",
  "url": "https://app.example.com/",
  "title": "Example"
}
```

---

## 3. Extension ↔ daemon protocol (Native Messaging)

Chrome Native Messaging framing: each message is a little-endian **uint32 length** followed by that
many bytes of **UTF-8 JSON**. Two directions:

**Extension → daemon** (`ingest`): batches of the events in §2.
```jsonc
{ "v": 1, "kind": "events", "events": [ /* console|network|session */ ] }
```

**Daemon → extension** (`control`): capture configuration + lifecycle.
```jsonc
{ "v": 1, "kind": "control",
  "capture": { "console": true, "network": true, "bodies": false },
  "limits":  { "perSessionEvents": 5000, "bodyMaxBytes": 65536 },
  "redact":  { "headers": ["authorization","cookie","set-cookie","proxy-authorization"] },
  "filter":  { "urlAllow": [], "urlDeny": [] } }
```

`v` is the protocol version (bump on breaking changes). The daemon is tolerant of unknown fields so
the extension and daemon can be upgraded independently.

---

## 4. CLI surface (`tether`)

Default output is a compact human table; `--json` emits the §2 schema (one object per line, JSONL)
for agents to parse. All read commands accept `--session <id>` / `--tab <id>` (default: the most
recently active session) and a relative `--since <dur>` (`30s`, `5m`, `1h`).

| Command | Purpose |
|---|---|
| `tether status` | Daemon up? connected extension, active tabs/sessions, capture state, buffer fill. |
| `tether sessions` | List active sessions (id, tabId, url, title, event counts, last activity). |
| `tether console [--level error,warn] [--grep <re>] [--since <dur>] [-n <count>] [--json]` | Recent console entries. |
| `tether net [--method GET] [--status 5xx\|4xx\|503] [--url <re>] [--type xhr,fetch] [--since] [-n] [--json]` | Recent network requests (one line each). |
| `tether get <requestId> [--headers] [--body]` | Full detail for one request incl. (redacted) headers and captured body. |
| `tether clear [--session]` | Drop buffered events (get a clean state before a repro). |
| `tether export [--format json\|har] [--session] [-o <file>]` | Export the session; **HAR** for network so it opens in any devtools/replay. |
| `tether watch [--level error] [--session]` | Live tail of new events (blocks; for interactive use). *Later.* |
| `tether config [get\|set] <key> [value]` | View/adjust capture toggles, limits, redaction, filters. |

Exit codes: `0` ok; `3` daemon not running; `4` no extension connected; `5` no matching session.
These let the Skill/agent branch cleanly (e.g. "daemon down → tell the human to start it").

---

## 5. Buffering & limits (bounded memory)

- **Per-session ring buffer**, capped by event count (`perSessionEvents`, default 5000) **and** total
  bytes; oldest events drop first. No unbounded growth.
- **Bodies are opt-in** (`capture.bodies`, default **off**) and size-capped (`bodyMaxBytes`, default
  64 KiB); larger bodies are stored truncated with the original `size` recorded.
- Closed sessions are retained briefly (configurable TTL) so the agent can still read logs right
  after a tab closes, then evicted.

## 6. Security & privacy (default-safe)

Console and network logs routinely contain **secrets** (auth tokens, cookies, session ids, PII).
Tether is default-safe so the agent never accidentally surfaces them:

- **Capture is opt-in / off by default.** The human enables it per the extension toggle; nothing is
  captured silently.
- **Header redaction on by default**: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`
  are replaced with `«redacted»` before leaving the extension. The denylist is configurable/extensible.
- **Bodies off by default** (§5); when enabled they are size-capped and subject to the same redaction
  pass for known token-shaped fields.
- **URL allow/deny filters** so capture can be scoped to the app under test.
- Everything stays **local** (extension ↔ `tetherd` over stdio; CLI ↔ daemon local IPC). No network
  egress, no telemetry.

> Note for the Skill/agent: even with redaction, treat exported logs as potentially sensitive — do
> not paste raw `tether export` output into shared channels.

---

## 7. Phase 0 scope (this PR) vs. follow-on

**This PR (Claude):** this design, the `SKILL.md` (agent guide), and the `extension/` skeleton
(MV3 manifest + capture/UI stubs with TODOs, English UI). No daemon/CLI code.

**Next (Codex), after this merges:** the Rust `tetherd` + `tether` implementing §3–§5. Then Claude
fills in the extension capture/UI against the daemon, and we cross-review. `tether watch` and HAR
export can land in a follow-up after the core query path works.
