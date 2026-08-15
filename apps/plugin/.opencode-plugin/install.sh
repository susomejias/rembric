#!/bin/sh
# rembric opencode plugin installer.
#
# Download plugin.ts and its shared modules from the rembric main branch and
# install them to ~/.config/opencode/plugins/ and ~/.config/rembric/bin/.
# The installer never edits opencode.json; it prints the MCP snippet instead.
# Honour PLUGIN_SRC, BIN_SRC and MCP_BRIDGE_SRC for local development.
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
#
# Usage (dev, local clone — no fetch):
#   PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" \
#   BIN_SRC="$(pwd)/apps/plugin/bin" \
#   MCP_BRIDGE_SRC="$(pwd)/apps/plugin/mcp-bridge" \
#     sh apps/plugin/.opencode-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin}"
BIN_SRC="${BIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/bin}"
MCP_BRIDGE_SRC="${MCP_BRIDGE_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/mcp-bridge}"

OPENCODE_DIR="${HOME}/.config/opencode"
OPENCODE_PLUGINS_DIR="${OPENCODE_DIR}/plugins"
OPENCODE_JSON="${OPENCODE_DIR}/opencode.json"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
PLUGIN_DEST="${OPENCODE_PLUGINS_DIR}/rembric.ts"
DOTENV_LIB='rembric-dotenv.mjs'
CORE_LIB='rembric-plugin-core.mjs'
# x-release-please-start-version
MCP_BRIDGE_VERSION='0.28.2'
# x-release-please-end
SHARED_LIBS="$DOTENV_LIB $CORE_LIB"

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
  http://* | https://*)
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

fetch_file "${MCP_BRIDGE_SRC}/${DOTENV_LIB}" "${REMBRIC_BIN_DIR}/${DOTENV_LIB}" || exit 1
fetch_file "${BIN_SRC}/${CORE_LIB}" "${REMBRIC_BIN_DIR}/${CORE_LIB}" || exit 1
for lib in $SHARED_LIBS; do chmod 644 "${REMBRIC_BIN_DIR}/${lib}"; done

# Every relative dev-time import is rewritten to its absolute installed path,
# which Bun's ESM resolver in opencode 1.15.x accepts.
TMP_PLUGIN="$(mktemp)"
trap 'rm -f "$TMP_PLUGIN"' EXIT
fetch_file "${PLUGIN_SRC}/plugin.ts" "$TMP_PLUGIN" || exit 1
REWRITE=''
REWRITE="s|'\.\./mcp-bridge/rembric-dotenv\.mjs'|'${REMBRIC_BIN_DIR}/${DOTENV_LIB}'|g
s|'\.\./bin/rembric-plugin-core\.mjs'|'${REMBRIC_BIN_DIR}/${CORE_LIB}'|g
"
sed "$REWRITE" "$TMP_PLUGIN" >"$PLUGIN_DEST"
# An import that drifts from its sed pattern above no-ops silently and crashes
# the installed plugin at load, so EVERY destination is verified, not one.
for lib in $SHARED_LIBS; do
  dest="${REMBRIC_BIN_DIR}/${lib}"
  if ! grep -qF "$dest" "$PLUGIN_DEST"; then
    rm -f "$PLUGIN_DEST"
    printf '[rembric] error: import rewrite failed — plugin.ts does not reference %s after sed; removed the broken plugin file\n' "$dest" >&2
    exit 1
  fi
done
chmod 644 "$PLUGIN_DEST"

mcp_block() {
  cat <<MCP
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["npx", "-y", "@rembric/mcp-bridge@${MCP_BRIDGE_VERSION}"],
      "environment": {
        "REMBRIC_SERVER_URL": "{env:REMBRIC_SERVER_URL}",
        "REMBRIC_API_TOKEN": "{env:REMBRIC_API_TOKEN}"
      },
      "enabled": true
    }
  }
}
MCP
}

cat <<EOF

  ✓ rembric opencode plugin installed.

  Plugin:     ${PLUGIN_DEST}
EOF

for lib in $SHARED_LIBS; do
  printf '  Shared lib: %s\n' "${REMBRIC_BIN_DIR}/${lib}"
done

cat <<EOF
  Config:     ${OPENCODE_JSON} (left untouched)

  Paste this MCP block into opencode.json. The config hook also upgrades
  existing mcp.rembric launcher entries in memory, so no config rewrite is needed:

$(mcp_block | sed 's/^/  /')

  Export your credentials in your shell rc:

    export REMBRIC_SERVER_URL="https://memory.example.com"
    export REMBRIC_API_TOKEN="<token from /dashboard/tokens>"

EOF
