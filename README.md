# Tether

[中文 README](README.zh-CN.md)

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
- **`skills/codex/tether/`** — installable Codex Skill that teaches Codex agents when/how to use `tether`.
- **`skills/claude-code/tether/`** — installable Claude Code Skill (runtime-specific; maintained separately).
- **`extension/`** — MV3 browser extension (TypeScript, English UI) — *Claude*.
- **`src/`** — Rust daemon + CLI (`tether daemon` / `tether`) — *Codex*.

## Status
**Phase 1 — end-to-end code path complete.** The repo includes the MV3 extension, Rust daemon/CLI,
native-host install path, and installable agent Skill. Remaining validation is real-browser GUI
acceptance on a machine with Chrome/Chromium.

## Development
```sh
cargo test
cargo build

# Local daemon without a browser native-host stdin/stdout:
tether daemon --no-native

# Install the Chrome/Chromium native-host manifest for the extension:
tether install-host
```

Requires Rust 1.95+ / Cargo lockfile v4. On machines with multiple Cargo installs, prefer the
rustup toolchain first:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

## Install Agent Skills
Install the skill that matches the agent runtime.

From a checkout:

```sh
skills/install.sh --target codex
skills/install.sh --target claude-code
```

Or install the Codex skill directly from GitHub:

```sh
python /path/to/skill-installer/scripts/install-skill-from-github.py \
  --repo EnSue-Laboratories/Tether \
  --path skills/codex/tether
```

Restart the agent runtime after installation so `$tether` is discovered.
