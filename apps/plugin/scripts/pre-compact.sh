#!/usr/bin/env bash
# PreCompact hook — shared by Claude Code and Codex CLI.
#
# Fires BEFORE the compactor runs, while the full transcript is still
# readable from `transcript_path`. We snapshot it to Rembric so the
# pre-compact state is durable on the server even if the model never
# calls memory.session_summary post-compact.
#
# Usage: pre-compact.sh [agent-name]
#   agent-name selects the per-client transcript parser:
#     "claude-code" (default) → _transcript.sh::*_claude_code helpers
#     "codex-cli"             → _transcript.sh::*_codex_cli helpers
#
# stdin (both clients): JSON object with `session_id`/`sessionId`, `cwd`,
# `transcript_path`. Claude Code additionally passes `compaction_trigger`
# (manual|auto); Codex may pass a similar field. We don't consume it.
#
# stdout: NONE. PreCompact stdout is documented (Claude Code) and
# expected-by-symmetry (Codex) to be "side effects only" — NOT injected
# into the model's context. Emitting plain text here would be noise at
# best and a Codex parser failure at worst.
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

SUMMARY=""
TITLE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  case "$AGENT" in
    codex-cli)
      SUMMARY="$(rembric_format_transcript_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      TITLE="$(rembric_extract_first_assistant_codex_cli "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      ;;
    *)
      SUMMARY="$(rembric_format_transcript_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      TITLE="$(rembric_extract_first_assistant_claude_code "$TRANSCRIPT_PATH" 2>/dev/null || true)"
      ;;
  esac
fi

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
else
  # Degraded mode — no transcript or empty parse. Still touch the row so
  # subsequent PostCompact lands on a known session.
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" "{}"
fi

exit 0
