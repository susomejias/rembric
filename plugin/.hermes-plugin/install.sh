#!/bin/sh
# rembric Hermes plugin installer.
#
# Default: download plugin.yaml, __init__.py, README.md from the rembric
# main branch into ${HERMES_HOME}/plugins/rembric/. Honour PLUGIN_SRC if
# set: a local directory path is copied with cp, an http(s):// prefix is
# fetched via curl.
#
# Usage (public repo / local clone):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
#
# Usage (private repo via PAT — export the same token before the pipe):
#   export GH_PAT=ghp_xxxxxxxx
#   curl -fsSL -H "Authorization: Bearer $GH_PAT" \
#     https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
#
# Usage (dev, local clone — no auth needed):
#   PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh

set -eu

PLUGIN_SRC="${PLUGIN_SRC:-https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
TARGET="${HERMES_HOME}/plugins/rembric"

# Optional bearer token for fetching from a private GitHub repo. Accepted
# names: GH_PAT (preferred), GH_TOKEN, GITHUB_TOKEN. First non-empty wins.
AUTH_TOKEN=""
for var_name in GH_PAT GH_TOKEN GITHUB_TOKEN; do
  eval "candidate=\${${var_name}:-}"
  if [ -n "$candidate" ]; then
    AUTH_TOKEN="$candidate"
    break
  fi
done

if ! mkdir -p "$TARGET" 2>/dev/null; then
  printf '[rembric] error: cannot create %s\n' "$TARGET" >&2
  exit 1
fi

fetch_file() {
  src_path="$1"
  dest_path="$2"
  case "$PLUGIN_SRC" in
    http://*|https://*)
      if [ -n "$AUTH_TOKEN" ]; then
        if ! curl -fsSL -H "Authorization: Bearer ${AUTH_TOKEN}" "$src_path" -o "$dest_path"; then
          printf '[rembric] error: failed to fetch %s (auth header was set)\n' "$src_path" >&2
          return 1
        fi
      else
        if ! curl -fsSL "$src_path" -o "$dest_path"; then
          printf '[rembric] error: failed to fetch %s (private repo? set GH_PAT)\n' "$src_path" >&2
          return 1
        fi
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
