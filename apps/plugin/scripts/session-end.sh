#!/usr/bin/env bash
# SessionEnd hook — shared by Claude Code and Codex CLI.
#
# Fires once when the host session truly ends (terminal close, /exit,
# /clear, logout). Per code.claude.com/docs/en/hooks, SessionEnd stdin
# carries {session_id, transcript_path, cwd, hook_event_name, reason}.
# Codex fires the same event for the main thread only (never a subagent)
# per learn.chatgpt.com/docs/hooks, with the same stdin fields.
#
# Usage: session-end.sh [agent-name]
#   agent-name selects the per-client transcript parser:
#     "claude-code" (default) → _transcript.sh::*_claude_code helpers
#     "codex-cli"             → _transcript.sh::*_codex_cli helpers
#
# This is the FALLBACK summary writer for the case where the agent did not
# call memory.session_summary mid-session. We read the transcript JSONL,
# format it, derive a title from the first assistant message, and POST
# /end {summary, title, final:false}. The server's write-once-with-final
# precedence preserves any model-authored summary (which would have arrived
# with final:true) and only falls back to this raw transcript when no final
# summary exists.
#
# Codex allows this ONE event 1 second by default and 3 seconds at most,
# against 600 for every other hook, so hooks.codex.json declares both
# "timeout": 3 and REMBRIC_POST_MAX_TIME=2 to leave room for the transcript
# read and the failure diagnostic. When the budget kills the handler the row
# stays active and abandonStale retires it, exactly as before.
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

AGENT="${1:-${REMBRIC_AGENT:-claude-code}}"

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

PARSER="${AGENT//-/_}"

SUMMARY=""
TITLE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  # Prefer the deterministic fact extraction over the raw transcript
  # format — grounded, checkable facts rather than a slice of the
  # conversation (`sessions`). Falls through to the raw formatter when the
  # extractor is unavailable for this agent (no `_rembric_facts_raw_codex_cli`
  # exists yet) or yields nothing.
  SUMMARY="$(rembric_session_facts "$PARSER" "$TRANSCRIPT_PATH" 2>/dev/null || true)"
  if [ -n "$SUMMARY" ]; then
    SUMMARY="$(_rembric_truncate_transcript "$SUMMARY")"
  else
    case "$AGENT" in
      codex-cli)
        SUMMARY="$(rembric_format_transcript_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
        ;;
      *)
        SUMMARY="$(rembric_format_transcript_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
        ;;
    esac
  fi
  case "$AGENT" in
    codex-cli)
      TITLE="$(rembric_extract_first_assistant_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      ;;
    *)
      TITLE="$(rembric_extract_first_assistant_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      ;;
  esac
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
