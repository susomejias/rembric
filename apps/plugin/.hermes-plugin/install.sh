#!/bin/sh
set -eu
if [ "$#" -ne 0 ]; then
    printf '[rembric] error: use the root TUI for flags; Hermes supports only the default native source.\n' >&2
    exit 2
fi

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
TARGET="${HERMES_HOME}/plugins/rembric"
ACTION="${REMBRIC_ACTION:-install}"
case "$ACTION" in install | update | uninstall) ;; *) exit 2 ;; esac
if [ -n "${PLUGIN_SRC:-}${REMBRIC_SRC:-}${REMBRIC_REF:-}" ]; then
    printf '[rembric] error: Hermes supports only the default native source; local sources and explicit refs are unsupported.\n' >&2
    exit 2
fi
command -v python3 >/dev/null 2>&1 || {
    printf '[rembric] error: Python 3 is required to validate Hermes source metadata.\n' >&2
    exit 1
}
STATE=$(python3 - "$HERMES_HOME" <<'PY'
import json
from pathlib import Path
import re
import sys

home = Path(sys.argv[1])
target = home / "plugins/rembric"
metadata = home / "plugins/.install-metadata.json"
try:
    if metadata.is_symlink() or target.is_symlink():
        raise ValueError()
    records = json.loads(metadata.read_text()) if metadata.exists() else {}
    if not isinstance(records, dict):
        raise ValueError()
    record = records.get("rembric")
    if not target.exists() and "rembric" not in records:
        print("absent")
    elif (target.is_dir() and (target / "plugin.yaml").is_file()
          and isinstance(record, dict)
          and record.get("source") == "https://github.com/susomejias/rembric.git#apps/plugin/.hermes-plugin"
          and record.get("pinned") is False
          and isinstance(record.get("revision"), str)
          and re.fullmatch(r"[0-9a-f]{40}", record["revision"])):
        print("native")
    else:
        raise ValueError()
except (OSError, ValueError, TypeError):
    print("unsupported")
PY
)
if [ "$STATE" = unsupported ]; then
    printf '[rembric] error: copied, linked, pinned, foreign or inconsistent Hermes install; no files changed.\n' >&2
    printf '  Make a complete backup outside plugins/, move the old directory aside explicitly, then use the root TUI to install natively. Preserve credentials and MCP settings; review native pins/source metadata separately.\n' >&2
    exit 1
fi
if [ "$STATE" = absent ] && [ "$ACTION" = uninstall ]; then
    printf '[rembric] Hermes plugin already absent.\n'
    exit 0
fi
if [ "$STATE" = absent ] && [ "$ACTION" = update ]; then
    printf '[rembric] error: Hermes plugin absent; use --agent=hermes --action=install.\n' >&2
    exit 1
fi
command -v hermes >/dev/null 2>&1 || {
    printf '[rembric] error: hermes binary unavailable; use the root TUI for printed commands.\n' >&2
    exit 1
}
case "$ACTION" in
install)
    if [ "$STATE" = native ]; then
        printf '[rembric] Hermes plugin already installed; use --action=update.\n'
        exit 0
    fi
    hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable
    ;;
update) hermes plugins update rembric ;;
uninstall) exec hermes plugins remove rembric ;;
esac

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

if [ "$ACTION" = update ]; then
    migrate_legacy_mcp_config
fi
