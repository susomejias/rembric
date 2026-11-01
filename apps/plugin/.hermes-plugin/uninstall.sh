#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -f "$SCRIPT_DIR/install.sh" ]; then
    printf '[rembric] error: use the root TUI: --agent=hermes --action=uninstall --yes\n' >&2
    exit 1
fi
REMBRIC_ACTION=uninstall exec sh "$SCRIPT_DIR/install.sh"
