#!/bin/sh
# rembric opencode plugin installer.
#
# Default: download plugin.ts, rembric-bridge.mjs, rembric-dotenv.mjs,
# rembric-plugin-core.mjs from the rembric main branch and install them to
# ~/.config/opencode/plugins/
# and ~/.config/rembric/bin/. ALSO auto-creates ~/.config/opencode/opencode.json
# with a `mcp.rembric` block that references the user's shell env vars
# (`{env:REMBRIC_SERVER_URL}` + `{env:REMBRIC_API_TOKEN}`), so the user only
# needs to export those in their shell rc. Idempotent. Honour PLUGIN_SRC +
# BIN_SRC if set: an http(s):// prefix is fetched via curl, a local
# directory path is copied with cp.
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
#
# Usage (dev, local clone — no fetch):
#   PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" \
#   BIN_SRC="$(pwd)/apps/plugin/bin" \
#     sh apps/plugin/.opencode-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin}"
BIN_SRC="${BIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/bin}"

OPENCODE_DIR="${HOME}/.config/opencode"
OPENCODE_PLUGINS_DIR="${OPENCODE_DIR}/plugins"
OPENCODE_JSON="${OPENCODE_DIR}/opencode.json"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
PLUGIN_DEST="${OPENCODE_PLUGINS_DIR}/rembric.ts"
BRIDGE_DEST="${REMBRIC_BIN_DIR}/rembric-bridge.mjs"
# The modules plugin.ts imports by relative dev-time path; this one list drives
# the fetch, the import rewrite, its verification and the summary.
SHARED_LIBS='rembric-dotenv.mjs rembric-plugin-core.mjs'

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

# Fetch the bridge + every shared lib verbatim. The bridge imports
# rembric-dotenv.mjs from the same directory, so they MUST land together.
fetch_file "${BIN_SRC}/rembric-bridge.mjs" "$BRIDGE_DEST" || exit 1
chmod 644 "$BRIDGE_DEST"
for lib in $SHARED_LIBS; do
  fetch_file "${BIN_SRC}/${lib}" "${REMBRIC_BIN_DIR}/${lib}" || exit 1
  chmod 644 "${REMBRIC_BIN_DIR}/${lib}"
done

# Every relative dev-time import is rewritten to its absolute installed path,
# which Bun's ESM resolver in opencode 1.15.x accepts.
TMP_PLUGIN="$(mktemp)"
trap 'rm -f "$TMP_PLUGIN"' EXIT
fetch_file "${PLUGIN_SRC}/plugin.ts" "$TMP_PLUGIN" || exit 1
REWRITE=''
for lib in $SHARED_LIBS; do
  REWRITE="${REWRITE}s|'\\.\\./bin/$(printf %s "$lib" | sed 's/\./\\./g')'|'${REMBRIC_BIN_DIR}/${lib}'|g
"
done
sed "$REWRITE" "$TMP_PLUGIN" > "$PLUGIN_DEST"
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

# Render the MCP snippet (used for auto-write OR for manual paste).
mcp_block() {
  cat <<MCP
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "${BRIDGE_DEST}"],
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

# has_mcp_rembric: detect an existing `mcp.rembric` entry without a jq
# dependency. A minimal character scanner (string/escape aware) tracks brace
# depth, finds the top-level "mcp" key, and looks for a "rembric" key directly
# inside that object — a "rembric" substring anywhere else (another server's
# name, an unrelated value) must NOT count as configured.
has_mcp_rembric() {
  [ -f "$OPENCODE_JSON" ] || return 1
  awk '
    BEGIN { depth = 0; instr = 0; esc = 0; buf = ""; pendmcp = 0; mcpd = -1; found = 0 }
    {
      line = $0
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (instr) {
          if (esc) esc = 0
          else if (c == "\\") esc = 1
          else if (c == "\"") instr = 0
          else buf = buf c
          continue
        }
        if (c == "\"") { instr = 1; buf = ""; continue }
        if (c == ":") {
          if (buf == "mcp" && depth == 1 && mcpd == -1) pendmcp = 1
          else if (buf == "rembric" && mcpd != -1 && depth == mcpd) found = 1
          buf = ""
          continue
        }
        if (c == "{") { depth++; if (pendmcp) { mcpd = depth; pendmcp = 0 }; continue }
        if (c == "}") { if (depth == mcpd) mcpd = -1; depth--; continue }
      }
    }
    END { exit found ? 0 : 1 }
  ' "$OPENCODE_JSON" 2>/dev/null
}

# Auto-configure ~/.config/opencode/opencode.json.
#
# Three branches:
#   (1) file does not exist  → create it with the rembric block (env-substitution)
#   (2) file exists, has NO mcp.rembric → leave untouched, print snippet to merge
#   (3) file exists, already has mcp.rembric → leave untouched, print one-liner
#
# We deliberately do NOT auto-merge in case (2): jq vs JSONC + arbitrary
# other-MCP-server entries make in-place merge risky.
configure_opencode_json() {
  if [ ! -e "$OPENCODE_JSON" ]; then
    mcp_block > "$OPENCODE_JSON"
    chmod 644 "$OPENCODE_JSON"
    AUTO_WROTE_JSON=1
    return 0
  fi
  if has_mcp_rembric; then
    AUTO_WROTE_JSON=2  # already configured
    return 0
  fi
  AUTO_WROTE_JSON=3  # exists, needs manual merge
  return 0
}

AUTO_WROTE_JSON=0
configure_opencode_json

cat <<EOF

  ✓ rembric opencode plugin installed.

  Plugin:     ${PLUGIN_DEST}
  Bridge:     ${BRIDGE_DEST}
EOF

for lib in $SHARED_LIBS; do
  printf '  Shared lib: %s\n' "${REMBRIC_BIN_DIR}/${lib}"
done

case "$AUTO_WROTE_JSON" in
  1)
    cat <<EOF
  Config:     ${OPENCODE_JSON}  (created, references shell env)

  One step left — export your credentials in your shell rc (~/.zshrc,
  ~/.bashrc, etc.) and restart your terminal:

    export REMBRIC_SERVER_URL="https://memory.example.com"   # no trailing /mcp
    export REMBRIC_API_TOKEN="<token from /dashboard/tokens>"

  Then start opencode in any repo with a .rembric file
  (containing PROJECT_SLUG=<slug>) to get per-project scoping.

EOF
    ;;
  2)
    cat <<EOF
  Config:     ${OPENCODE_JSON}  (already has mcp.rembric — skipped)

  No changes needed. Make sure your shell has the credentials exported:

    export REMBRIC_SERVER_URL="https://memory.example.com"
    export REMBRIC_API_TOKEN="<token from /dashboard/tokens>"

EOF
    ;;
  3)
    cat <<EOF
  Config:     ${OPENCODE_JSON}  (EXISTS — manual merge required)

  Your opencode.json already exists but has no mcp.rembric block.
  Add the following block under "mcp":

  ----------------------------------------------------------------------
$(mcp_block | sed 's/^/  /')
  ----------------------------------------------------------------------

  Then export your credentials in your shell rc:

    export REMBRIC_SERVER_URL="https://memory.example.com"
    export REMBRIC_API_TOKEN="<token from /dashboard/tokens>"

EOF
    ;;
esac

cat <<EOF
  Per-project path-scoping: drop a .rembric file at each repo root with
  PROJECT_SLUG=<slug>. The bridge reads it at spawn time and connects to
  /mcp/<slug> automatically. Without .rembric the plugin no-ops cleanly.

EOF
