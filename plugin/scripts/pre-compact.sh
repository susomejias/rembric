#!/usr/bin/env bash
# PreCompact hook: persists the compact transcript as the session summary
# before context is compressed.
#
# Reads `session_id` from stdin and the rest of stdin as the summary body.
# POSTs `/api/<slug>/sessions/<id>/summary {summary}`. No stdout — the host
# is about to compact, model-visible output here is wasted.
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

# Use the entire stdin payload as the summary body. The server clamps at
# 20k chars (sessionSummarySchema.max) and rejects empty strings.
SUMMARY="$INPUT"
# Truncate to leave headroom under the server's 20 000-char limit.
MAX_SUMMARY=19500
if [ "${#SUMMARY}" -gt "$MAX_SUMMARY" ]; then
  SUMMARY="${SUMMARY:0:$MAX_SUMMARY}"
fi

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ] && [ -n "$SUMMARY" ]; then
  SUMMARY_ESC="$(rembric_json_escape "$SUMMARY")"
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" "{\"summary\":\"${SUMMARY_ESC}\"}"
fi

exit 0
