#!/bin/sh
# rembric opencode plugin installer.
#
# Download plugin.ts, its shared modules and the MCP bridge from the rembric
# main branch and install them to ~/.config/opencode/plugins/ and ~/.config/rembric/bin/.
# The installer never edits opencode.json; the plugin config hook owns its MCP entry.
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
PROJECT_LIB='rembric-project.mjs'
CORE_LIB='rembric-plugin-core.mjs'
SHARED_LIBS="$DOTENV_LIB $PROJECT_LIB $CORE_LIB"
# cli.mjs goes last, so its presence means every module it imports is in place.
BRIDGE_MODULES='slug.mjs rembric-host-binding.mjs bridge.mjs cli.mjs'
# rembric-dotenv.mjs is reached through rembric-project.mjs's own relative import.
IMPORTED_LIBS="$PROJECT_LIB $CORE_LIB"

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

install_file() {
  staged="${2}.tmp.$$"
  if ! fetch_file "$1" "$staged"; then
    rm -f "$staged"
    return 1
  fi
  chmod 644 "$staged"
  mv -f "$staged" "$2"
}

install_file "${MCP_BRIDGE_SRC}/${DOTENV_LIB}" "${REMBRIC_BIN_DIR}/${DOTENV_LIB}" || exit 1
install_file "${MCP_BRIDGE_SRC}/${PROJECT_LIB}" "${REMBRIC_BIN_DIR}/${PROJECT_LIB}" || exit 1
install_file "${BIN_SRC}/${CORE_LIB}" "${REMBRIC_BIN_DIR}/${CORE_LIB}" || exit 1
for module in $BRIDGE_MODULES; do
  install_file "${MCP_BRIDGE_SRC}/${module}" "${REMBRIC_BIN_DIR}/${module}" || exit 1
done

# Every relative dev-time import is rewritten to its absolute installed path,
# which Bun's ESM resolver in opencode 1.15.x accepts.
TMP_PLUGIN="$(mktemp)"
trap 'rm -f "$TMP_PLUGIN"' EXIT
fetch_file "${PLUGIN_SRC}/plugin.ts" "$TMP_PLUGIN" || exit 1
REWRITE=''
REWRITE="s|'\.\./mcp-bridge/rembric-dotenv\.mjs'|'${REMBRIC_BIN_DIR}/${DOTENV_LIB}'|g
s|'\.\./mcp-bridge/rembric-project\.mjs'|'${REMBRIC_BIN_DIR}/${PROJECT_LIB}'|g
s|'\.\./bin/rembric-plugin-core\.mjs'|'${REMBRIC_BIN_DIR}/${CORE_LIB}'|g
"
sed "$REWRITE" "$TMP_PLUGIN" >"$PLUGIN_DEST"
# An import that drifts from its sed pattern above no-ops silently and crashes
# the installed plugin at load, so EVERY destination is verified, not one.
for lib in $IMPORTED_LIBS; do
  dest="${REMBRIC_BIN_DIR}/${lib}"
  if ! grep -qF "$dest" "$PLUGIN_DEST"; then
    rm -f "$PLUGIN_DEST"
    printf '[rembric] error: import rewrite failed — plugin.ts does not reference %s after sed; removed the broken plugin file\n' "$dest" >&2
    exit 1
  fi
done
if grep -qF "'../" "$PLUGIN_DEST"; then
  rm -f "$PLUGIN_DEST"
  printf '[rembric] error: import rewrite failed — plugin.ts still has a relative ../ import after sed; removed the broken plugin file\n' >&2
  exit 1
fi
chmod 644 "$PLUGIN_DEST"

cat <<EOF

  ✓ rembric opencode plugin installed.

  Plugin:     ${PLUGIN_DEST}
EOF

for lib in $SHARED_LIBS; do
  printf '  Shared lib: %s\n' "${REMBRIC_BIN_DIR}/${lib}"
done

cat <<EOF
  Bridge:     node ${REMBRIC_BIN_DIR}/cli.mjs
  Config:     ${OPENCODE_JSON} (left untouched)

  The config hook adds the MCP entry in memory and upgrades legacy launchers.
  Export your credentials in your shell rc:

    export REMBRIC_SERVER_URL="https://memory.example.com"
    export REMBRIC_API_TOKEN="<token from /dashboard/tokens>"

EOF
