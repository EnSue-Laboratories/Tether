#!/usr/bin/env bash
# Install the Tether native-messaging host manifest so Chrome can launch the daemon when the
# extension calls connectNative("com.ensue.tether"). User-level install; Linux/macOS.
#
#   native-host/install.sh [path/to/tether]
#
# This is the transparent/fallback path. The official entry point is `tether install-host`
# (same result, resolves the binary via current_exe()).
set -euo pipefail

HOST_NAME="com.ensue.tether"
EXT_ID="lcbgiapgidfgdaohjbofohaokokcpefd"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/$HOST_NAME.json"

# 1. Locate the tether binary: arg 1, then $TETHER_BIN, then release/debug builds, then PATH.
TETHER_BIN="${1:-${TETHER_BIN:-}}"
if [ -z "$TETHER_BIN" ]; then
  for cand in "$SCRIPT_DIR/../target/release/tether" "$SCRIPT_DIR/../target/debug/tether" "$(command -v tether 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then TETHER_BIN="$cand"; break; fi
  done
fi
if [ -z "$TETHER_BIN" ] || [ ! -x "$TETHER_BIN" ]; then
  echo "error: tether binary not found. Build it, or pass the path: native-host/install.sh /path/to/tether" >&2
  exit 1
fi
TETHER_BIN="$(cd "$(dirname "$TETHER_BIN")" && pwd)/$(basename "$TETHER_BIN")"  # absolute path

# 2. The daemon enters native-host mode only when argv0 ends with 'tetherd'. Chrome launches the
#    manifest `path` directly (no subcommand), so point it at a sibling `tetherd` symlink.
TETHERD_LINK="$(dirname "$TETHER_BIN")/tetherd"
ln -sf "$TETHER_BIN" "$TETHERD_LINK"

# 3. Render the manifest with the resolved path.
MANIFEST="$(sed "s#TETHERD_PATH#$TETHERD_LINK#" "$TEMPLATE")"

# 4. Write it into every Chrome-family NativeMessagingHosts dir we should target.
case "$(uname -s)" in
  Darwin)
    BASES=("$HOME/Library/Application Support/Google/Chrome"
           "$HOME/Library/Application Support/Chromium") ;;
  *)
    BASES=("$HOME/.config/google-chrome" "$HOME/.config/chromium") ;;
esac

installed=0
for base in "${BASES[@]}"; do
  # Always install for Chrome; for others only if a profile already exists.
  if [[ "$base" == *"google-chrome"* || "$base" == *"/Google/Chrome" ]] || [ -d "$base" ]; then
    dir="$base/NativeMessagingHosts"
    mkdir -p "$dir"
    printf '%s\n' "$MANIFEST" > "$dir/$HOST_NAME.json"
    echo "installed: $dir/$HOST_NAME.json"
    installed=$((installed + 1))
  fi
done

echo "host '$HOST_NAME' -> $TETHERD_LINK"
echo "allowed extension id: $EXT_ID"
[ "$installed" -gt 0 ] || { echo "warning: no Chrome dirs written" >&2; exit 1; }
