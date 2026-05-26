# Tether — Claude Code skill

A [Claude Code](https://claude.com/claude-code) skill that lets an agent read the browser's console
and network logs via the `tether` CLI (and set Tether up if it isn't installed).

## Install
```sh
skills/claude-code/install-skill.sh
```
Copies `tether/` into `~/.claude/skills/tether/` (override with `CLAUDE_SKILLS_DIR`). A new Claude
Code session then discovers it; its description triggers when you're debugging a web app and need
console errors or failed/slow network requests.

## Contents
- `tether/SKILL.md` — the skill: when to use it, self-serve **Setup** (build daemon + extension,
  `tether install-host`, load the extension), and **Use** (`tether status/sessions/console/net/get/clear`).

> The matching **Codex skill** lives separately (owned by Codex). This directory is the Claude Code
> form only.
