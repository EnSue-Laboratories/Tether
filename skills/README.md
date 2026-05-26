# Tether Agent Skills

Install the skill for the agent runtime you use.

You can use the unified installer from a checkout:

```sh
skills/install.sh --target codex
skills/install.sh --target claude-code
```

## Codex

Or install the Codex skill directly from GitHub with Codex's skill-installer:

```sh
python /path/to/skill-installer/scripts/install-skill-from-github.py \
  --repo EnSue-Laboratories/Tether \
  --path skills/codex/tether
```

Restart Codex after installation so `$tether` is discovered.

## Claude Code

Claude Code uses `skills/claude-code/tether/` and installs to `~/.claude/skills/tether/` by default.
Set `CLAUDE_SKILLS_DIR` to override the destination.
