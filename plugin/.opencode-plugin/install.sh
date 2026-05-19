#!/usr/bin/env bash
# Rembric opencode plugin installer.
# Idempotent. Run from anywhere; resolves the source repo via git rev-parse.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "[rembric] install.sh must be run from within the rembric checkout." >&2
  exit 1
fi

PLUGIN_SRC="${REPO_ROOT}/plugin/.opencode-plugin/plugin.ts"
BRIDGE_SRC="${REPO_ROOT}/plugin/bin/rembric-bridge.mjs"
DOTENV_SRC="${REPO_ROOT}/plugin/bin/rembric-dotenv.mjs"

for src in "${PLUGIN_SRC}" "${BRIDGE_SRC}" "${DOTENV_SRC}"; do
  if [ ! -f "${src}" ]; then
    echo "[rembric] missing source: ${src}" >&2
    exit 1
  fi
done

OPENCODE_PLUGINS_DIR="${HOME}/.config/opencode/plugins"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
PLUGIN_DEST="${OPENCODE_PLUGINS_DIR}/rembric.ts"
BRIDGE_DEST="${REMBRIC_BIN_DIR}/rembric-bridge.mjs"
DOTENV_DEST="${REMBRIC_BIN_DIR}/rembric-dotenv.mjs"

mkdir -p "${OPENCODE_PLUGINS_DIR}"
mkdir -p "${REMBRIC_BIN_DIR}"

# Copy the bridge + shared dotenv lib verbatim. The bridge imports
# rembric-dotenv.mjs from the same directory, so they MUST land together.
cp "${BRIDGE_SRC}" "${BRIDGE_DEST}"
cp "${DOTENV_SRC}" "${DOTENV_DEST}"
chmod 644 "${BRIDGE_DEST}" "${DOTENV_DEST}"

# Patch the plugin's relative import (`../bin/rembric-dotenv.mjs`, used at
# dev time so `tsc --noEmit` and `pnpm vitest` resolve against the
# monorepo layout) to the absolute installed path before copying.
# Bun resolves absolute paths in ESM imports — verified against opencode
# 1.15.5's bundled runtime during the cwd spike.
sed "s|'\\.\\./bin/rembric-dotenv\\.mjs'|'${DOTENV_DEST}'|g" "${PLUGIN_SRC}" > "${PLUGIN_DEST}"
chmod 644 "${PLUGIN_DEST}"

cat <<EOF

  Rembric opencode plugin installed.

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
