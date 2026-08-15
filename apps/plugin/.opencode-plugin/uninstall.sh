#!/bin/sh
# Rembric opencode plugin uninstaller. Idempotent — never touches opencode.json.
# POSIX sh (no bashisms): the TUI installer runs this via `sh`, which is dash on
# many systems — `set -o pipefail` / arrays would abort there.

set -u

REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
REMBRIC_DIR="${HOME}/.config/rembric"
PLUGIN_DEST="${HOME}/.config/opencode/plugins/rembric.ts"
# Must stay in step with install.sh's list, which is what put these on disk.
SHARED_LIBS='rembric-dotenv.mjs rembric-plugin-core.mjs'

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
for lib in $SHARED_LIBS; do
  drop "${REMBRIC_BIN_DIR}/${lib}"
done

rmdir "$REMBRIC_BIN_DIR" 2>/dev/null || true
rmdir "$REMBRIC_DIR" 2>/dev/null || true

printf '\n  Rembric opencode plugin uninstall complete.\n\n'

if [ -n "$removed" ]; then
  printf '  Removed:\n%s\n' "$removed"
fi

if [ -n "$absent" ]; then
  printf '  Not present (already absent):\n%s\n' "$absent"
fi

printf '  NOT removed (edit manually if you want them gone):\n'
printf '    - any legacy rembric-bridge.mjs launcher left by an older install\n'
printf '    - mcp.rembric block in ~/.config/opencode/opencode.json\n'
printf '    - mcp.rembric block in any per-project ./opencode.json\n'
printf '    - .rembric files in your project repos\n\n'
