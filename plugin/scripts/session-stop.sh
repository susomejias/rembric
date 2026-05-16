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
trap '_emit_json' ERR

_emit_json() {
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

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  SUMMARY="$(rembric_format_transcript "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  TITLE="$(rembric_extract_first_assistant "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  if [ -n "$SUMMARY" ]; then
    SUMMARY_ESC="$(rembric_json_escape "$SUMMARY")"
    if [ -n "$TITLE" ]; then
      TITLE_ESC="$(rembric_json_escape "$TITLE")"
      rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
        "{\"summary\":\"${SUMMARY_ESC}\",\"title\":\"${TITLE_ESC}\",\"final\":false}"
    else
      rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
        "{\"summary\":\"${SUMMARY_ESC}\",\"final\":false}"
    fi
  fi
fi

# Codex Stop MUST emit JSON on stdout — plain text is rejected.
printf '{}'
exit 0
