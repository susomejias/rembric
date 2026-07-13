#!/usr/bin/env bash
# UserPromptSubmit hook — Claude Code + Codex CLI. Fires on every user prompt
# (matcher-less; Codex ignores the manifest matcher anyway) and carries BOTH
# the save and session-summary reminders on one per-session turn counter.
# Plain stdout is the correct injection shape on UserPromptSubmit for both
# clients (unlike PostToolUse, which requires hookSpecificOutput JSON).
set -u
trap 'exit 0' ERR

SAVE_NUDGE_EVERY=5
SUMMARY_NUDGE_EVERY=10
SAVE_NUDGE='rembric: if recent work produced a decision, fix, or discovery, you MUST call memory.save now (title ≤100 + content).'
SUMMARY_NUDGE='rembric: did real work happen this turn? You MUST call memory.session_summary({title, summary}) now — title ≤100 chars (the work, not cwd); summary: Goal · Discoveries · Accomplished · Next Steps · Files. Nothing memorable? Skip.'
SESSION_ID_NUDGE_TEMPLATE='rembric: sessionId="{{SESSION_ID}}" — pass it explicitly to memory.save/memory.session_summary/memory.save_prompt now, to guarantee correct attachment; never guess a different one.'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

RAW_SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
SESSION_ID="$RAW_SESSION_ID"
[ -z "$SESSION_ID" ] && SESSION_ID="nosession"
SAFE_ID="$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9_.-' '_')"

DIR="${TMPDIR:-/tmp}/rembric-turnnudge"
mkdir -p "$DIR" 2>/dev/null || true
FILE="${DIR}/${SAFE_ID}"
# Append-and-count-bytes instead of read-increment-write: a single O_APPEND
# write is atomic even across concurrent invocations, so turns can never be
# lost to a race the way a read-modify-write counter could.
printf '.' >>"$FILE" 2>/dev/null || true
COUNT="$(wc -c <"$FILE" 2>/dev/null | tr -d '[:space:]')"
case "$COUNT" in
  '' | *[!0-9]*) COUNT=0 ;;
esac

SAVE_FIRES=0
SUMMARY_FIRES=0
[ $((COUNT % SAVE_NUDGE_EVERY)) -eq 0 ] && SAVE_FIRES=1
{ [ "$COUNT" -eq 1 ] || [ $((COUNT % SUMMARY_NUDGE_EVERY)) -eq 0 ]; } && SUMMARY_FIRES=1

if [ -n "$RAW_SESSION_ID" ] && { [ "$SAVE_FIRES" -eq 1 ] || [ "$SUMMARY_FIRES" -eq 1 ]; }; then
  echo "${SESSION_ID_NUDGE_TEMPLATE//\{\{SESSION_ID\}\}/$RAW_SESSION_ID}"
fi
[ "$SAVE_FIRES" -eq 1 ] && echo "$SAVE_NUDGE"
[ "$SUMMARY_FIRES" -eq 1 ] && echo "$SUMMARY_NUDGE"

exit 0
