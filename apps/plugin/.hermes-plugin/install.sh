#!/bin/sh
set -eu
if [ "$#" -ne 0 ]; then
  printf '[rembric] error: use the root TUI for flags; Hermes supports only the default native source.\n' >&2
  exit 2
fi

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
export HERMES_HOME
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
STATE=$(
  python3 - "$HERMES_HOME" "$ACTION" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

home = Path(sys.argv[1]).absolute()
target = home / "plugins/rembric"
metadata = home / "plugins/.install-metadata.json"


def state():
    if home.is_symlink() or target.parent.is_symlink() or metadata.is_symlink() or target.is_symlink():
        return "unsupported"
    records = json.loads(metadata.read_text()) if metadata.exists() else {}
    if not isinstance(records, dict):
        return "unsupported"
    record = records.get("rembric")
    if not target.exists() and "rembric" not in records:
        return "absent"
    if (target.is_dir() and (target / "plugin.yaml").is_file()
            and isinstance(record, dict)
            and record.get("source") == "https://github.com/susomejias/rembric.git#apps/plugin/.hermes-plugin"
            and record.get("pinned") is False
            and isinstance(record.get("revision"), str)
            and re.fullmatch(r"[0-9a-f]{40}", record["revision"])):
        return "native"
    if ("rembric" not in records and target.is_dir() and not (target / ".git").exists()
            and all((target / name).is_file() and not (target / name).is_symlink()
                    for name in ("plugin.yaml", "__init__.py", "README.md"))):
        manifest = (target / "plugin.yaml").read_text()
        if (re.search(r"^name: rembric$", manifest, re.M)
                and re.search(r"^homepage: https://github.com/susomejias/rembric$", manifest, re.M)
                and re.search(r"^class RembricMemoryProvider\(MemoryProvider\):", (target / "__init__.py").read_text(), re.M)):
            return "legacy"
    return "unsupported"


def idle():
    try:
        rows = subprocess.check_output(["ps", "-ww", "-axo", "pid=,args="], text=True, timeout=10).splitlines()
        processes = [row.strip().split(None, 1) for row in rows if row.strip()]
        if not any(pid == str(os.getpid()) for pid, _ in processes):
            raise ValueError("incomplete process list")
        for pid, command in processes:
            if pid != str(os.getpid()) and re.search(
                    r"(?:^|[\s/])(?:hermes(?:\s|$)|hermes_cli(?:[./\s]|$)|hermes-agent/|run_agent\.py(?:\s|$)|gateway/run\.py(?:\s|$))", command):
                raise ValueError("Hermes is running; stop it and automatic restarts first")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise ValueError(f"Hermes activity cannot be ruled out: {exc}") from exc


def digest(path):
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
        raise ValueError(f"unsupported linked/special file: {path}")
    if path.is_dir():
        return (stat.S_IMODE(mode), {p.name: digest(p) for p in path.iterdir()})
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            checksum.update(chunk)
    return (stat.S_IMODE(mode), checksum.hexdigest())


def copy_snapshot(source, destination):
    owner = source.stat()
    shutil.copy2(source, destination)
    copied = destination.stat()
    if (copied.st_uid, copied.st_gid) != (owner.st_uid, owner.st_gid):
        os.chown(destination, owner.st_uid, owner.st_gid)
        shutil.copystat(source, destination)
    copied = destination.stat()
    if (copied.st_uid, copied.st_gid) != (owner.st_uid, owner.st_gid):
        raise ValueError("snapshot ownership verification failed")


def publications():
    roots = [home]
    if home.parent.name == "profiles":
        roots.append(home.parent.parent)
    facts = {}
    for root in roots:
        installs = root / "installs"
        if installs.is_symlink():
            raise ValueError("linked Hermes install state")
        if not installs.exists():
            continue
        for install in installs.iterdir():
            if install.is_symlink() or (install / "publication.json").exists() or (install / "publication.json").is_symlink():
                raise ValueError("pending Hermes publication; use native recovery before migration")
            fact = install / "facts.json"
            if fact.exists():
                facts[str(fact)] = digest(fact)
    return facts


def migrate():
    if os.environ.get("REMBRIC_NONINTERACTIVE") == "1":
        raise ValueError("legacy migration requires interactive TUI confirmation; --yes is not migration consent")
    if shutil.which("hermes") is None:
        raise ValueError("hermes binary unavailable")
    idle()
    before_facts = publications()
    paths = [home / "config.yaml", home / ".env", metadata]
    original = {path: digest(path) if path.exists() or path.is_symlink() else None for path in paths}
    before = digest(target)
    with open("/dev/tty") as tty, open("/dev/tty", "w") as prompt:
        prompt.write("\nLegacy Rembric detected. Stop all Hermes CLI/gateway/Desktop processes and automatic restarts.\n"
                  "Keep Hermes stopped until completion. A private full backup will be retained.\n"
                  "Type MIGRATE to back up and install natively (anything else cancels): ")
        prompt.flush()
        if tty.readline().strip() != "MIGRATE":
            raise ValueError("migration cancelled; no files changed")
        lock = home / ".rembric-migration.lock"
        lock.mkdir(mode=0o700)
        moved = False
        safe = True
        try:
            idle()
            if state() != "legacy" or digest(target) != before or publications() != before_facts:
                raise ValueError("installation changed; retry after inspection")
            backup = Path(tempfile.mkdtemp(prefix="rembric-backup-", dir=home))
            print(f"[rembric] Backup: {backup}", file=sys.stderr, flush=True)
            shutil.copytree(target, backup / "rembric")
            for path, expected in original.items():
                if (digest(path) if path.exists() or path.is_symlink() else None) != expected:
                    raise ValueError("configuration changed; no migration performed")
                if expected is not None:
                    saved = backup / path.relative_to(home)
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    copy_snapshot(path, saved)
                    if digest(saved) != expected:
                        raise ValueError("configuration backup verification failed")
            if digest(backup / "rembric") != before or digest(target) != before:
                raise ValueError("plugin backup verification failed")
            idle()
            target.rename(backup / "previous")
            moved = True
            try:
                subprocess.run(["hermes", "plugins", "install", "susomejias/rembric/apps/plugin/.hermes-plugin", "--enable"],
                               stdin=tty, stdout=sys.stderr, check=True)
                if state() != "native" or not (target / "__init__.py").is_file():
                    raise ValueError("native installation verification failed")
                publications()
            except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
                safe = False
                idle()
                if publications() != before_facts:
                    raise ValueError(f"Hermes dependency state changed; manual recovery required. Backup: {backup}")
                for path in paths:
                    if path.is_symlink() or (path.exists() and not path.is_file()):
                        raise ValueError(f"configuration changed type; manual recovery required. Backup: {backup}")
                if target.exists() or target.is_symlink():
                    target.rename(backup / "failed-plugin")
                (backup / "previous").rename(target)
                for path, expected in original.items():
                    if path.exists():
                        failed = backup / "failed" / path.relative_to(home)
                        failed.parent.mkdir(parents=True, exist_ok=True)
                        path.rename(failed)
                    if expected is not None:
                        copy_snapshot(backup / path.relative_to(home), path)
                if digest(target) != before or any(
                        (digest(p) if p.exists() else None) != expected for p, expected in original.items()):
                    raise ValueError(f"restore verification failed; inspect backup: {backup}")
                safe = True
                print("[rembric] Previous installation restored; backup retained.", file=sys.stderr)
                raise
            print("[rembric] Migration verified; backup retained. Restart Hermes only after completion.", file=sys.stderr)
        finally:
            if safe or not moved:
                lock.rmdir()
            else:
                print(f"[rembric] Recovery incomplete. Keep Hermes stopped; backup retained at {backup}; lock: {lock}", file=sys.stderr)


try:
    current = state()
except (OSError, ValueError, TypeError):
    current = "unsupported"
if current == "legacy" and sys.argv[2] == "update":
    try:
        migrate()
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        print(f"[rembric] migration stopped: {exc}", file=sys.stderr)
        sys.exit(1)
    print("migrated")
else:
    print("unsupported" if current == "legacy" else current)
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
update) if [ "$STATE" != migrated ]; then hermes plugins update rembric; fi ;;
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
