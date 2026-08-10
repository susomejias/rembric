#!/usr/bin/env bash
# UserPromptSubmit hook — Claude Code + Codex CLI. Fires on every user prompt
# (matcher-less; Codex ignores the manifest matcher anyway) and carries BOTH
# the save and session-summary reminders on one per-session turn counter.
# Plain stdout is the correct injection shape on UserPromptSubmit for both
# clients (unlike PostToolUse, which requires hookSpecificOutput JSON).
set -u
trap 'exit 0' ERR

SAVE_NUDGE_EVERY=5
SAVE_NUDGE='rembric: if recent work produced a decision, fix, or discovery, you MUST call memory.save now (title ≤100 + content).'
SUMMARY_NUDGE='rembric: did real work happen this turn? You MUST call memory.session_summary({title, summary}) now — title ≤100 chars (the work, not cwd); summary: Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files. Nothing memorable? Skip.'
SESSION_ID_NUDGE_TEMPLATE='rembric: sessionId="{{SESSION_ID}}" — pass it explicitly to memory.save/memory.session_summary/memory.save_prompt now, to guarantee correct attachment; never guess a different one.'
RESUMED_READ_NUDGE='rembric: this session existed before this process attached to it — call memory.session_get before your next memory.session_summary write.'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

RAW_SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"

COUNT="$(rembric_turn_count rembric-turnnudge "$RAW_SESSION_ID")"
case "$COUNT" in
  # Counter unreadable (unwritable TMPDIR, squatted counter dir, etc.) —
  # fail CLOSED: emit nothing. Defaulting to 0 here would satisfy BOTH
  # modulo checks below (0 % 5 == 0 and 0 % 10 == 0), spamming every
  # nudge on every single turn for the rest of the session.
  '' | *[!0-9]*) exit 0 ;;
esac

SAVE_FIRES=0
SUMMARY_FIRES=0
[ $((COUNT % SAVE_NUDGE_EVERY)) -eq 0 ] && SAVE_FIRES=1
# Turn 1 only: that firing is protocol (call session_summary at least once), not
# a reminder about work already done. stop-nudge.sh owns the every-N firing.
[ "$COUNT" -eq 1 ] && SUMMARY_FIRES=1

if [ -n "$RAW_SESSION_ID" ] && { [ "$SAVE_FIRES" -eq 1 ] || [ "$SUMMARY_FIRES" -eq 1 ]; }; then
  echo "${SESSION_ID_NUDGE_TEMPLATE//\{\{SESSION_ID\}\}/$RAW_SESSION_ID}"
fi
[ "$SAVE_FIRES" -eq 1 ] && echo "$SAVE_NUDGE"
if [ "$SUMMARY_FIRES" -eq 1 ]; then
  # This hook's summary line fires only on turn 1, so this IS the first
  # firing of the process — the sibling read line belongs here, never at
  # stop-nudge.sh's later every-N firing.
  if [ -n "$RAW_SESSION_ID" ] && rembric_resumed_peek "$RAW_SESSION_ID"; then
    echo "$RESUMED_READ_NUDGE"
  fi
  echo "$SUMMARY_NUDGE"
fi

exit 0
