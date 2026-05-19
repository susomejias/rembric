#!/usr/bin/env bash
# Rembric opencode plugin uninstaller. Idempotent — never touches opencode.json.

set -uo pipefail

PLUGIN_DEST="${HOME}/.config/opencode/plugins/rembric.ts"
BRIDGE_DEST="${HOME}/.config/rembric/bin/rembric-bridge.mjs"
DOTENV_DEST="${HOME}/.config/rembric/bin/rembric-dotenv.mjs"
REMBRIC_BIN_DIR="${HOME}/.config/rembric/bin"
REMBRIC_DIR="${HOME}/.config/rembric"

removed=()
absent=()

for target in "${PLUGIN_DEST}" "${BRIDGE_DEST}" "${DOTENV_DEST}"; do
  if [ -e "${target}" ]; then
    rm -f "${target}"
    removed+=("${target}")
  else
    absent+=("${target}")
  fi
done

rmdir "${REMBRIC_BIN_DIR}" 2>/dev/null || true
rmdir "${REMBRIC_DIR}" 2>/dev/null || true

cat <<EOF

  Rembric opencode plugin uninstall complete.

EOF

if [ ${#removed[@]} -gt 0 ]; then
  echo "  Removed:"
  for f in "${removed[@]}"; do echo "    ${f}"; done
  echo
fi

if [ ${#absent[@]} -gt 0 ]; then
  echo "  Not present (already absent):"
  for f in "${absent[@]}"; do echo "    ${f}"; done
  echo
fi

cat <<EOF
  NOT removed (edit manually if you want them gone):
    - mcp.rembric block in ~/.config/opencode/opencode.json
    - mcp.rembric block in any per-project ./opencode.json
    - .rembric files in your project repos

EOF
