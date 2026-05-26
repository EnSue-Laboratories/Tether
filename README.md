# Tether

Browser **console + network logs** for AI agents — so an agent can read what happened in the page
instead of you manually capturing it. A browser extension streams console and network events to a
local daemon; agents read them through a small `tether` CLI, guided by a Skill.

```
browser extension  ──Native Messaging──▶  tetherd (daemon)  ──query──▶  tether CLI  ◀── SKILL.md
 (console+network)                         per-session buffers           (any agent / shell)
```

**Decision:** CLI + Skill, no MCP — a CLI works for every agent that can run a shell, and the Skill
teaches the agent when/how to use it.

## Layout
- **`docs/DESIGN.md`** — the contract: data model, extension↔daemon protocol, CLI surface, limits, security.
- **`skill/SKILL.md`** — the agent-facing guide (when/how to use `tether`).
- **`extension/`** — MV3 browser extension (TypeScript, English UI) — *Claude*.
- **`src/`** — Rust daemon + CLI (`tether daemon` / `tether`) — *Codex*.

## Status
**Phase 1 — Rust daemon/CLI core in progress.** The current CLI/daemon implements the local Unix
socket query path, Native Messaging ingest, per-session buffers, and the first read commands.
Extension capture/UI wiring follows against this interface.

## Development
```sh
cargo test
cargo build

# Local daemon without a browser native-host stdin/stdout:
tether daemon --no-native
```

Requires Rust 1.95+ / Cargo lockfile v4. On machines with multiple Cargo installs, prefer the
rustup toolchain first:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```
