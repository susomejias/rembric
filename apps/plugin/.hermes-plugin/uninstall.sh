#!/bin/sh
# rembric Hermes plugin uninstaller. Idempotent — never touches
# ${HERMES_HOME}/.env, stored credentials, or .rembric project markers.
#
# Mirrors apps/plugin/.opencode-plugin/uninstall.sh: removes only the three
# plugin-owned files, rmdir's the empty plugin dir, best-effort disables the
# plugin, and reports what it deliberately left in place.
#
# Usage:
#   sh apps/plugin/.hermes-plugin/uninstall.sh
#   HERMES_HOME=/custom/path sh apps/plugin/.hermes-plugin/uninstall.sh

set -u

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
TARGET="${HERMES_HOME}/plugins/rembric"

removed=''
absent=''

for f in plugin.yaml __init__.py README.md; do
  path="${TARGET}/${f}"
  if [ -e "$path" ]; then
    rm -f "$path"
    removed="${removed}    ${path}
"
  else
    absent="${absent}    ${path}
"
  fi
done

rmdir "$TARGET" 2>/dev/null || true

# Best-effort disable — a missing hermes binary or already-disabled plugin
# MUST NOT fail the uninstall.
if command -v hermes >/dev/null 2>&1; then
  hermes plugins disable rembric >/dev/null 2>&1 || true
fi

printf '\n  Rembric Hermes plugin uninstall complete.\n\n'

if [ -n "$removed" ]; then
  printf '  Removed:\n%s\n' "$removed"
fi

if [ -n "$absent" ]; then
  printf '  Not present (already absent):\n%s\n' "$absent"
fi

printf '  NOT removed (delete manually if you want them gone):\n'
printf '    - %s/.env  (your credentials)\n' "$HERMES_HOME"
printf '    - .rembric files in your project repos\n\n'
