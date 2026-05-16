#!/usr/bin/env bash
# SessionEnd hook — Claude Code only.
#
# Fires once when the host session truly ends (terminal close, /exit,
# /clear, logout). Per code.claude.com/docs/en/hooks, SessionEnd stdin
# carries {session_id, transcript_path, cwd, hook_event_name, reason}.
#
# This is the FALLBACK summary writer for the Claude Code case where the
# agent did not call memory.session_summary mid-session. We read the
# transcript JSONL, format it, derive a title from the first assistant
# message, and POST /end {summary, title, final:false}. The server's
# write-once-with-final precedence preserves any model-authored summary
# (which would have arrived with final:true) and only falls back to this
# raw transcript when no final summary exists.
#
# Codex CLI has no equivalent hook event — Codex uses Stop per-turn
# (see session-stop.sh) and sessions stay active until abandonStale.
#
# SessionEnd stdout is NOT injected into the model's context (the model
# is already gone), so we emit nothing.
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

if [ -z "$SESSION_ID" ] || [ -z "$SLUG" ]; then
  exit 0
fi

SUMMARY=""
TITLE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  SUMMARY="$(rembric_format_transcript_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  TITLE="$(rembric_extract_first_assistant_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
fi

if [ -n "$SUMMARY" ]; then
  SUMMARY_ESC="$(rembric_json_escape "$SUMMARY")"
  if [ -n "$TITLE" ]; then
    TITLE_ESC="$(rembric_json_escape "$TITLE")"
    rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/end" \
      "{\"summary\":\"${SUMMARY_ESC}\",\"title\":\"${TITLE_ESC}\",\"final\":false}"
  else
    rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/end" \
      "{\"summary\":\"${SUMMARY_ESC}\",\"final\":false}"
  fi
else
  # Degraded mode: no transcript or empty parse — still transition to ended.
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/end" "{}"
fi

exit 0
