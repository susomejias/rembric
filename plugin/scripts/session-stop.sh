#!/usr/bin/env bash
# Stop hook — Codex CLI only.
#
# Codex's Stop hook fires once per agent turn (verified against
# developers.openai.com/codex/hooks). Codex has no SessionEnd, no
# PreCompact/PostCompact, and no SessionStart matcher:"compact". Stop is
# the ONLY signal we have for any kind of session-progress update.
#
# Strategy: every turn, read the transcript_path JSONL (which contains
# the full conversation so far), format it, derive a title from the first
# assistant message, and POST /summary {summary, title, final:false}.
# The server's write-once-with-final precedence preserves any model
# summary written via memory.session_summary (final:true). The session
# row stays `active` — Codex has no way to signal "this is the LAST
# Stop" so we never transition; the daily `abandonStale` sweep flips
# old rows to `abandoned`.
#
# Codex docs require JSON on Stop stdout: "Stop expects JSON on stdout
# when it exits 0. Plain text output is invalid for this event." We emit
# `{}` after the POST.
#
# Claude Code does NOT wire this script (Claude has the proper
# SessionEnd event and uses session-end.sh instead).
set -u

# TEMP DIAGNOSTIC — full stdin + parsed vars dump. Remove once diagnosed.
DIAG=/tmp/codex-stop-diag2.log

trap '_emit_json' ERR

_emit_json() {
  echo "[ERR trap fired] $(date -u +%FT%T)" >> "$DIAG" 2>/dev/null || true
  printf '{}'
  exit 0
}

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

{
  echo "========== $(date -u +%FT%T.%NZ) =========="
  echo "argv: $*"
  echo "REMBRIC_SERVER_URL=${REMBRIC_SERVER_URL:-<unset>}"
  echo "REMBRIC_API_TOKEN(len)=${#REMBRIC_API_TOKEN}"
  echo "-- STDIN (${#INPUT} chars) --"
  printf '%s\n' "$INPUT"
  echo "-- end stdin --"
  echo "SESSION_ID=[${SESSION_ID}]"
  echo "CWD=[${CWD}]"
  echo "TRANSCRIPT_PATH=[${TRANSCRIPT_PATH}]"
  if [ -n "$TRANSCRIPT_PATH" ]; then
    if [ -f "$TRANSCRIPT_PATH" ]; then
      echo "TRANSCRIPT_FILE: exists, size=$(wc -c < "$TRANSCRIPT_PATH")"
      echo "-- first 3 lines --"
      head -3 "$TRANSCRIPT_PATH" 2>/dev/null
      echo "-- end head --"
    else
      echo "TRANSCRIPT_FILE: missing on disk"
    fi
  else
    echo "TRANSCRIPT_PATH: empty (Codex did not provide it)"
  fi
  echo "SLUG=[${SLUG}]"
} >> "$DIAG" 2>/dev/null || true

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  SUMMARY="$(rembric_format_transcript_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  TITLE="$(rembric_extract_first_assistant_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  echo "[POST path] summary_len=${#SUMMARY} title=[${TITLE}]" >> "$DIAG" 2>/dev/null || true
  if [ -n "$SUMMARY" ]; then
    SUMMARY_ESC="$(rembric_json_escape "$SUMMARY")"
    if [ -n "$TITLE" ]; then
      TITLE_ESC="$(rembric_json_escape "$TITLE")"
      rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
        "{\"summary\":\"${SUMMARY_ESC}\",\"title\":\"${TITLE_ESC}\",\"final\":false}"
      echo "[POSTED with title]" >> "$DIAG" 2>/dev/null || true
    else
      rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
        "{\"summary\":\"${SUMMARY_ESC}\",\"final\":false}"
      echo "[POSTED no title]" >> "$DIAG" 2>/dev/null || true
    fi
  else
    echo "[skip POST: empty summary]" >> "$DIAG" 2>/dev/null || true
  fi
else
  echo "[skip POST: precondition failed]" >> "$DIAG" 2>/dev/null || true
fi

# Codex Stop MUST emit JSON on stdout — plain text is rejected.
printf '{}'
exit 0
