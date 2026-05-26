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
- `tetherd` / `tether` — Rust daemon + CLI (single binary) — *Codex* (after Phase 0 merges).

## Status
**Phase 0 — design + skeleton** (this design + the extension/skill skeleton). The Rust daemon/CLI
implements `docs/DESIGN.md` next; then the extension capture/UI is wired up.
