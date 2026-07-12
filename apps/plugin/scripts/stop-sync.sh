#!/usr/bin/env bash
# Stop hook — Claude Code only. Fires once per assistant turn (NOT once per
# session — see the claude-code-plugin spec's note on why a prior Stop hook
# was removed and why this one is safe: it never posts to /end and never
# transitions session status, so it cannot trigger that historical bug).
#
# Pure side effect: raw per-turn transcript sync to /summary. The `final`
# field is omitted entirely (never sent as true), so a curated
# memory.session_summary always wins via the server's last-final-wins
# precedence. Emits NO stdout under any circumstance — this hook must never
# touch the model's context.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"
# shellcheck source=./_transcript.sh
source "${SCRIPT_DIR}/_transcript.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
TRANSCRIPT_PATH="$(rembric_transcript_path_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_read_project_slug "$CWD")"

if [ -z "$SESSION_ID" ] || [ -z "$SLUG" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

SUMMARY="$(rembric_format_transcript_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
[ -z "$SUMMARY" ] && exit 0
TITLE="$(rembric_extract_first_assistant_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"

SUMMARY_ESC="$(rembric_json_escape "$SUMMARY")"
if [ -n "$TITLE" ]; then
  TITLE_ESC="$(rembric_json_escape "$TITLE")"
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
    "{\"summary\":\"${SUMMARY_ESC}\",\"title\":\"${TITLE_ESC}\"}"
else
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
    "{\"summary\":\"${SUMMARY_ESC}\"}"
fi

exit 0
