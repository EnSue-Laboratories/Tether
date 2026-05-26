#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: skills/install.sh --target codex|claude-code [--force]

Installs the Tether skill for the selected agent runtime.

Targets:
  codex        -> ${CODEX_HOME:-$HOME/.codex}/skills/tether
  claude-code  -> ${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/tether

Options:
  --force      Replace an existing installed skill directory.
USAGE
}

target=""
force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$target" ]]; then
  echo "Missing --target" >&2
  usage >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$target" in
  codex)
    src="$script_dir/codex/tether"
    dest_root="${CODEX_HOME:-$HOME/.codex}/skills"
    ;;
  claude-code)
    src="$script_dir/claude-code/tether"
    dest_root="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    ;;
  *)
    echo "Unsupported target: $target" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ ! -f "$src/SKILL.md" ]]; then
  echo "Skill source not found: $src" >&2
  echo "This runtime's skill may not be present in the current checkout yet." >&2
  exit 1
fi

dest="$dest_root/tether"
if [[ -e "$dest" ]]; then
  if [[ "$force" -ne 1 ]]; then
    echo "Destination already exists: $dest" >&2
    echo "Re-run with --force to replace it." >&2
    exit 1
  fi
  rm -rf "$dest"
fi

mkdir -p "$dest_root"
cp -R "$src" "$dest"
echo "Installed Tether $target skill to $dest"
echo "Restart the agent runtime so the skill is discovered."
