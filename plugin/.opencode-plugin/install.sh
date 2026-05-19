#!/bin/sh
# rembric opencode plugin installer.
#
# Default: download plugin.ts, rembric-bridge.mjs, rembric-dotenv.mjs from
# the rembric main branch and install them to ~/.config/opencode/plugins/
# and ~/.config/rembric/bin/. Idempotent. Honour PLUGIN_SRC + BIN_SRC if
# set: an http(s):// prefix is fetched via curl, a local directory path is
# copied with cp.
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin/install.sh | sh
#
# Usage (dev, local clone — no fetch):
#   PLUGIN_SRC="$(pwd)/plugin/.opencode-plugin" \
#   BIN_SRC="$(pwd)/plugin/bin" \
#     sh plugin/.opencode-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin}"
BIN_SRC="${BIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/plugin/bin}"

OPENCODE_PLUGINS_DIR="${HOME}/.config/opencode/plugins"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
PLUGIN_DEST="${OPENCODE_PLUGINS_DIR}/rembric.ts"
BRIDGE_DEST="${REMBRIC_BIN_DIR}/rembric-bridge.mjs"
DOTENV_DEST="${REMBRIC_BIN_DIR}/rembric-dotenv.mjs"

if ! mkdir -p "$OPENCODE_PLUGINS_DIR" 2>/dev/null; then
  printf '[rembric] error: cannot create %s\n' "$OPENCODE_PLUGINS_DIR" >&2
  exit 1
fi
if ! mkdir -p "$REMBRIC_BIN_DIR" 2>/dev/null; then
  printf '[rembric] error: cannot create %s\n' "$REMBRIC_BIN_DIR" >&2
  exit 1
fi

fetch_file() {
  src_path="$1"
  dest_path="$2"
  case "$src_path" in
    http://*|https://*)
      if ! curl -fsSL "$src_path" -o "$dest_path"; then
        printf '[rembric] error: failed to fetch %s\n' "$src_path" >&2
        return 1
      fi
      ;;
    *)
      if [ -f "$src_path" ]; then
        cp "$src_path" "$dest_path"
      else
        printf '[rembric] error: missing local file %s\n' "$src_path" >&2
        return 1
      fi
      ;;
  esac
  return 0
}

# Fetch the bridge + shared dotenv lib verbatim. The bridge imports
# rembric-dotenv.mjs from the same directory, so they MUST land together.
fetch_file "${BIN_SRC}/rembric-bridge.mjs" "$BRIDGE_DEST" || exit 1
fetch_file "${BIN_SRC}/rembric-dotenv.mjs" "$DOTENV_DEST" || exit 1
chmod 644 "$BRIDGE_DEST" "$DOTENV_DEST"

# Fetch plugin.ts into a temp file, then sed-substitute the relative dev-time
# import (`from '../bin/rembric-dotenv.mjs'`) for the absolute installed path
# before writing to the final destination. Bun's ESM resolver in opencode
# 1.15.x accepts absolute paths — verified during the add-opencode-plugin
# cwd spike.
TMP_PLUGIN="$(mktemp)"
trap 'rm -f "$TMP_PLUGIN"' EXIT
fetch_file "${PLUGIN_SRC}/plugin.ts" "$TMP_PLUGIN" || exit 1
sed "s|'\\.\\./bin/rembric-dotenv\\.mjs'|'${DOTENV_DEST}'|g" "$TMP_PLUGIN" > "$PLUGIN_DEST"
chmod 644 "$PLUGIN_DEST"

cat <<EOF

  ✓ rembric opencode plugin installed.

  Plugin:     ${PLUGIN_DEST}
  Bridge:     ${BRIDGE_DEST}
  Dotenv lib: ${DOTENV_DEST}

  One step left: paste the MCP block below into your opencode.json.

  Locations (whichever you use):
    Global:       ${HOME}/.config/opencode/opencode.json
    Per project:  ./opencode.json

  Replace <REMBRIC_SERVER_URL> and <REMBRIC_API_TOKEN> with real values
  from /dashboard/tokens. Restart opencode after editing.

  ----------------------------------------------------------------------
  {
    "mcp": {
      "rembric": {
        "type": "local",
        "command": ["node", "${BRIDGE_DEST}"],
        "environment": {
          "REMBRIC_SERVER_URL": "<REMBRIC_SERVER_URL>",
          "REMBRIC_API_TOKEN": "<REMBRIC_API_TOKEN>"
        },
        "enabled": true
      }
    }
  }
  ----------------------------------------------------------------------

  Per-project path-scoping: drop a .rembric file at each repo root with
  PROJECT_SLUG=<slug>. The bridge reads it at spawn time and connects to
  /mcp/<slug> automatically. Without .rembric the plugin no-ops cleanly.

EOF
