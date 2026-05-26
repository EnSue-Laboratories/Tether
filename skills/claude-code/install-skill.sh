#!/usr/bin/env bash
# Install the Tether Claude Code skill into the user's personal skills dir, so any Claude Code
# session can discover and use it. (This installs the *skill*; `tether install-host` installs the
# native-messaging host — see the skill's Setup section.)
#
#   skills/claude-code/install-skill.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tether"
DEST_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$DEST_DIR/tether"

[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found" >&2; exit 1; }
mkdir -p "$DEST_DIR"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
echo "installed Claude Code skill 'tether' -> $DEST"
echo "A new Claude Code session will discover it (triggers on browser console/network debugging)."
