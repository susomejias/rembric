#!/usr/bin/env bash
# PostToolUse hook — Claude Code + Codex CLI. After a write-shaped tool, remind
# the model to persist salient work with memory.save, throttled to every Nth
# such call. On PostToolUse only hookSpecificOutput.additionalContext reaches
# the model (plain stdout is logged, not injected), so we emit that JSON shape.
set -u
trap 'exit 0' ERR

NUDGE_EVERY=8
NUDGE='rembric: if recent work produced a decision, fix, or discovery, call memory.save now (title ≤100 + content).'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

TOOL="$(rembric_tool_name_from_stdin_json "$INPUT")"
# Codex ignores the manifest matcher, so self-filter; unknown tool → no nudge.
case "$TOOL" in
  Edit | Write | MultiEdit | NotebookEdit) ;;
  *) exit 0 ;;
esac

SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
[ -z "$SESSION_ID" ] && SESSION_ID="nosession"
SAFE_ID="$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9_.-' '_')"

DIR="${TMPDIR:-/tmp}/rembric-savenudge"
mkdir -p "$DIR" 2>/dev/null || true
FILE="${DIR}/${SAFE_ID}"
COUNT=0
[ -f "$FILE" ] && COUNT="$(cat "$FILE" 2>/dev/null || printf '0')"
case "$COUNT" in
  '' | *[!0-9]*) COUNT=0 ;;
esac
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" >"$FILE" 2>/dev/null || true

[ $((COUNT % NUDGE_EVERY)) -ne 0 ] && exit 0

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' \
  "$(rembric_json_escape "$NUDGE")"
exit 0
