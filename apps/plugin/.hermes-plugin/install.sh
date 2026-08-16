#!/bin/sh
# rembric Hermes plugin installer.
#
# Default: download plugin.yaml, __init__.py, README.md from the rembric
# main branch into ${HERMES_HOME}/plugins/rembric/. Honour PLUGIN_SRC if
# set: a local directory path is copied with cp, an http(s):// prefix is
# fetched via curl.
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
#
# Usage (dev, local clone — no fetch):
#   PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
TARGET="${HERMES_HOME}/plugins/rembric"

if ! mkdir -p "$TARGET" 2>/dev/null; then
    printf '[rembric] error: cannot create %s\n' "$TARGET" >&2
    exit 1
fi

fetch_file() {
    src_path="$1"
    dest_path="$2"
    case "$PLUGIN_SRC" in
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

for f in plugin.yaml __init__.py README.md; do
    fetch_file "${PLUGIN_SRC}/${f}" "${TARGET}/${f}" || exit 1
done

migrate_legacy_mcp_config() {
    config="${HERMES_HOME}/config.yaml"
    version=$(sed -n 's/^version:[[:space:]]*\([0-9][0-9.]*\).*/\1/p' "${TARGET}/plugin.yaml" | head -1)
    [ -f "$config" ] && [ -n "$version" ] || return 0
    command -v python3 >/dev/null 2>&1 || {
        printf '[rembric] warning: Python 3 is unavailable; update mcp_servers.rembric manually\n' >&2
        return 0
    }
    python3 - "$config" "$version" <<'PY'
from pathlib import Path
import re
import shutil
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
lines = path.read_text().splitlines(keepends=True)
for start, line in enumerate(lines):
    if line.strip() != "mcp_servers:" or line[: len(line) - len(line.lstrip())]:
        continue
    index = start + 1
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index == len(lines) or lines[index].strip() != "rembric:" or not lines[index].startswith("  "):
        continue
    end = index + 1
    while end < len(lines):
        candidate = lines[end]
        if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= 2:
            break
        end += 1
    block = "".join(lines[index:end])
    keys = [
        entry.strip().split(":", 1)[0]
        for entry in lines[index + 1:end]
        if len(entry) - len(entry.lstrip()) == 4 and ":" in entry
    ]
    legacy = (
        "mcp-remote@" in block
        and "Authorization: Bearer ${REMBRIC_API_TOKEN}" in block
        and all(key in {"command", "args"} for key in keys)
    )
    incomplete = (
        keys == ["command", "args"]
        and re.search(r"^    args: \['-y', '@rembric/mcp-bridge@[0-9]+\.[0-9]+\.[0-9]+'\]\n?$", block, re.MULTILINE)
        and "env:" not in block
        and "enabled:" not in block
    )
    if not (legacy or incomplete):
        continue
    suffix = "rembric-mcp-remote" if legacy else "rembric-mcp-env"
    backup = path.with_name(f"{path.name}.{suffix}.bak")
    if not backup.exists():
        shutil.copy2(path, backup)
    replacement = [
        "  rembric:\n",
        "    command: npx\n",
        f"    args: ['-y', '@rembric/mcp-bridge@{version}']\n",
        "    env:\n",
        "      REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}\n",
        "      REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}\n",
        "      REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}\n",
        "    enabled: true\n",
    ]
    path.write_text("".join(lines[:index] + replacement + lines[end:]))
    print(f"[rembric] migrated mcp_servers.rembric; backup: {backup}")
    break
PY
}

if [ "${REMBRIC_ACTION:-install}" = "update" ]; then
    migrate_legacy_mcp_config
fi

printf '✓ rembric installed at %s\n' "$TARGET"
printf '  enable: hermes plugins enable rembric\n'
