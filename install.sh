#!/bin/sh
# rembric installer — canonical entry point.
#
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
#
# This is a THIN FORWARDER. All logic lives in apps/plugin/install.sh (the
# orchestrator: server prep + every client plugin, install/update/uninstall).
# From a clone it execs the sibling script; over curl|sh it fetches that script
# at the same ref. Every flag/env (--server --client --action --up --ref,
# REMBRIC_SRC, REMBRIC_NONINTERACTIVE, NO_COLOR) passes through unchanged.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo '')
REAL="${SCRIPT_DIR}/apps/plugin/install.sh"

if [ -n "$SCRIPT_DIR" ] && [ -f "$REAL" ]; then
  exec sh "$REAL" "$@"
fi

# Piped (no local checkout): fetch apps/plugin/install.sh at the chosen ref.
REF="${REMBRIC_REF:-main}"
for _a in "$@"; do
  case "$_a" in --ref=*) REF="${_a#--ref=}" ;; esac
done
RAW="https://raw.githubusercontent.com/susomejias/rembric/${REF}/apps/plugin/install.sh"

if ! command -v curl >/dev/null 2>&1; then
  printf '[rembric] error: curl is required to fetch the installer\n' >&2
  exit 1
fi
_tmp=$(mktemp)
if ! curl -fsSL --max-time 30 --retry 2 --retry-connrefused "$RAW" -o "$_tmp"; then
  rm -f "$_tmp"
  printf '[rembric] error: failed to fetch %s\n' "$RAW" >&2
  exit 1
fi
sh "$_tmp" "$@"
_rc=$?
rm -f "$_tmp"
exit "$_rc"
