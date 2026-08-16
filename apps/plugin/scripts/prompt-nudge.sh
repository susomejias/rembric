#!/usr/bin/env bash
# UserPromptSubmit hook — Claude Code + Codex CLI. Fires on every user prompt
# (matcher-less; Codex ignores the manifest matcher anyway). Prints, at the
# START of a turn, the lines the PREVIOUS turn's stop-report.sh cached:
# the sessionId line (when a write-directing line follows), the session
# opening (once, on a genuinely new session), and the server-composed
# notice, verbatim (session-nudges). Counts nothing: the firing decision
# belongs to the server.
set -u
trap 'exit 0' ERR

SESSION_OPENING_NUDGE='rembric: New session — before you finish this turn, call memory.session_summary with a title and a single `## Goal` section describing what this session is for; the other five canonical headings are intentionally left out.'
SESSION_ID_NUDGE_TEMPLATE='rembric: sessionId="{{SESSION_ID}}" — pass it explicitly to memory.save/memory.session_summary/memory.save_prompt now, to guarantee correct attachment; never guess a different one.'
RESUMED_READ_NUDGE='rembric: this session existed before this process attached to it — call memory.session_get before your next memory.session_summary write.'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"
# shellcheck source=./_transcript.sh
source "${SCRIPT_DIR}/_transcript.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

RAW_SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
PROMPT="$(rembric_prompt_from_stdin_json "$INPUT")"

[ -z "$RAW_SESSION_ID" ] && exit 0

# Record the FIRST user prompt, redacted, for stop-report.sh's first report
# (design D12). Write-once: rembric_first_prompt_write no-ops on a session
# that already has one recorded.
if [ -n "$PROMPT" ]; then
  # Redact before truncation — cutting first could sever an opening
  # <private> tag and leak the span content (same ordering as
  # _rembric_truncate_transcript).
  REDACTED_PROMPT="$(rembric_redact_private "$PROMPT")"
  rembric_first_prompt_write "$RAW_SESSION_ID" "${REDACTED_PROMPT:0:100}"
fi

PENDING="$(rembric_pending_take "$RAW_SESSION_ID")"

# rembric_once_claim fires exactly once per (marker, session id) — the CLAIM
# itself, not the peek, is what decides whether THIS run is the one that
# emits the opening/resumed-read line, so a later run whose peek still
# reads true (a persistent marker) does not re-fire it.
OPENING_DUE=0
if rembric_created_peek "$RAW_SESSION_ID" && rembric_once_claim rembric-opening-emitted "$RAW_SESSION_ID"; then
  OPENING_DUE=1
fi

RESUMED_DUE=0
if [ "$OPENING_DUE" -eq 0 ] && rembric_resumed_peek "$RAW_SESSION_ID" && rembric_once_claim rembric-resumed-emitted "$RAW_SESSION_ID"; then
  RESUMED_DUE=1
fi

# "Write-directing" (plugin-session-protocol) covers the notice and the
# opening only — resumedRead is a sibling line, never one that brings the
# sessionId line on its own.
WRITE_DIRECTING=0
[ -n "$PENDING" ] && WRITE_DIRECTING=1
[ "$OPENING_DUE" -eq 1 ] && WRITE_DIRECTING=1

if [ "$WRITE_DIRECTING" -eq 1 ]; then
  echo "${SESSION_ID_NUDGE_TEMPLATE//\{\{SESSION_ID\}\}/$RAW_SESSION_ID}"
fi

if [ "$OPENING_DUE" -eq 1 ]; then
  echo "$SESSION_OPENING_NUDGE"
elif [ "$RESUMED_DUE" -eq 1 ]; then
  echo "$RESUMED_READ_NUDGE"
fi

if [ -n "$PENDING" ]; then
  printf '%s\n' "$PENDING"
fi

exit 0
