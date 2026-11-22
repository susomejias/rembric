#!/bin/sh
# Rembric opencode plugin uninstaller. Idempotent — never touches opencode.json.
# POSIX sh (no bashisms): the TUI installer runs this via `sh`, which is dash on
# many systems — `set -o pipefail` / arrays would abort there.

set -u

REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
REMBRIC_DIR="${HOME}/.config/rembric"
PLUGIN_DEST="${HOME}/.config/opencode/plugins/rembric.ts"
# Must stay in step with install.sh's lists, which are what put these on disk.
OPENCODE_ONLY_LIBS='rembric-plugin-core.mjs'
BRIDGE_MODULES='cli.mjs bridge.mjs slug.mjs rembric-host-binding.mjs rembric-project.mjs rembric-dotenv.mjs'
HERMES_CONFIG="${HERMES_HOME:-${HOME}/.hermes}/config.yaml"

hermes_runs_bridge() {
  [ -f "$HERMES_CONFIG" ] || return 1
  grep -qF "${REMBRIC_BIN_DIR}/cli.mjs" "$HERMES_CONFIG" && return 0
  grep -qF '~/.config/rembric/bin/cli.mjs' "$HERMES_CONFIG"
}

removed=''
absent=''
drop() {
  if [ -e "$1" ]; then
    rm -f "$1"
    removed="${removed}    ${1}
"
  else
    absent="${absent}    ${1}
"
  fi
}

drop "$PLUGIN_DEST"
for lib in $OPENCODE_ONLY_LIBS; do
  drop "${REMBRIC_BIN_DIR}/${lib}"
done
kept=''
if hermes_runs_bridge; then
  for module in $BRIDGE_MODULES; do
    [ -e "${REMBRIC_BIN_DIR}/${module}" ] && kept="${kept}    ${REMBRIC_BIN_DIR}/${module}
"
  done
else
  for module in $BRIDGE_MODULES; do
    drop "${REMBRIC_BIN_DIR}/${module}"
  done
fi

rmdir "$REMBRIC_BIN_DIR" 2>/dev/null || true
rmdir "$REMBRIC_DIR" 2>/dev/null || true

printf '\n  Rembric opencode plugin uninstall complete.\n\n'

if [ -n "$removed" ]; then
  printf '  Removed:\n%s\n' "$removed"
fi

if [ -n "$absent" ]; then
  printf '  Not present (already absent):\n%s\n' "$absent"
fi

if [ -n "$kept" ]; then
  printf '  Bridge kept for Hermes (%s runs it):\n%s\n' "$HERMES_CONFIG" "$kept"
fi

printf '  NOT removed (edit manually if you want them gone):\n'
printf '    - any legacy rembric-bridge.mjs launcher left by an older install\n'
printf '    - mcp.rembric block in ~/.config/opencode/opencode.json\n'
printf '    - mcp.rembric block in any per-project ./opencode.json\n'
printf '    - .rembric files in your project repos\n\n'
