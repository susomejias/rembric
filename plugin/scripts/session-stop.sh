#!/usr/bin/env bash
# Stop hook: marks the Rembric session as ended when the host agent stops.
#
# Designed to run with `async: true` from the hook manifest so the host
# isn't blocked on network IO. POSTs `/api/<slug>/sessions/<id>/end`.
# No stdout.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_read_project_slug "$CWD")"

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ]; then
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/end" "{}"
fi

exit 0
