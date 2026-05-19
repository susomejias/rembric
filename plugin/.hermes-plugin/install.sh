#!/bin/sh
# rembric Hermes plugin installer.
#
# Default: download plugin.yaml, __init__.py, README.md from the rembric
# main branch into ${HERMES_HOME}/plugins/rembric/. Honour PLUGIN_SRC if
# set: a local directory path is copied with cp, an http(s):// prefix is
# fetched via curl.
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
#
# Usage (dev, local clone — no fetch):
#   PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin}"
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
    http://*|https://*)
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

printf '✓ rembric installed at %s\n' "$TARGET"
printf '  enable: hermes plugins enable rembric\n'
