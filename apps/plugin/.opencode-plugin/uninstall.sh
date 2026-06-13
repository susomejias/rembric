#!/bin/sh
# Rembric opencode plugin uninstaller. Idempotent — never touches opencode.json.
# POSIX sh (no bashisms): the TUI installer runs this via `sh`, which is dash on
# many systems — `set -o pipefail` / arrays would abort there.

set -u

PLUGIN_DEST="${HOME}/.config/opencode/plugins/rembric.ts"
BRIDGE_DEST="${HOME}/.config/rembric/bin/rembric-bridge.mjs"
DOTENV_DEST="${HOME}/.config/rembric/bin/rembric-dotenv.mjs"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
REMBRIC_DIR="${HOME}/.config/rembric"

removed=''
absent=''
for target in "$PLUGIN_DEST" "$BRIDGE_DEST" "$DOTENV_DEST"; do
  if [ -e "$target" ]; then
    rm -f "$target"
    removed="${removed}    ${target}
"
  else
    absent="${absent}    ${target}
"
  fi
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
printf '    - mcp.rembric block in ~/.config/opencode/opencode.json\n'
printf '    - mcp.rembric block in any per-project ./opencode.json\n'
printf '    - .rembric files in your project repos\n\n'
