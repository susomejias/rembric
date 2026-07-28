#!/usr/bin/env bash
# End-of-turn summary reminder — Claude Code + Codex CLI.
#
# This is the reminder that used to live on UserPromptSubmit. It MOVED rather
# than being added: the start of a turn is the one moment the reminder cannot be
# acted on, because there is always more work coming. The end of the turn is when
# the work is finished and the model can still write the summary.
#
# It reads the SAME per-session counter `prompt-nudge.sh` advances, at the same
# cadence, via `rembric_turn_count_peek` — reading rather than advancing, because
# two increments per turn would silently halve the cadence.
#
# NON-INTERRUPTING. `hookSpecificOutput.additionalContext` only: this never
# returns the host's blocking decision. A memory server is an optional accessory
# to its host and must not be able to hold a turn open.
#
# Separate from stop-sync.sh, which stays async: an async hook is fire-and-forget
# by the host's contract and cannot contribute feedback to the turn at all.
set -u
trap 'exit 0' ERR

SUMMARY_NUDGE_EVERY=10
# The reminder's facts are INJECTED context, not stored content, so they get a
# much tighter bound than the stored fallback body's 10 000. Enough to ground a
# summary, not the whole ledger. Tail-kept, consistently with the server's
# truncation direction: the later facts are the ones the turn just produced.
RBR_NUDGE_MAX_FACTS_CHARS=1800

AGENT="${1:-claude-code}"
PARSER="${AGENT//-/_}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"
# shellcheck source=./_transcript.sh
source "${SCRIPT_DIR}/_transcript.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

_emit_nothing() {
  # Codex expects a JSON object even when there is nothing to say.
  [ "$AGENT" = "codex-cli" ] && printf '{}'
  exit 0
}

RAW_SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
COUNT="$(rembric_turn_count_peek rembric-turnnudge "$RAW_SESSION_ID")"
case "$COUNT" in
  # Unreadable counter fails CLOSED, matching prompt-nudge.sh: defaulting to 0
  # would satisfy the modulo below and remind on every single turn.
  '' | *[!0-9]*) _emit_nothing ;;
esac
{ [ "$COUNT" -eq 1 ] || [ $((COUNT % SUMMARY_NUDGE_EVERY)) -eq 0 ]; } || _emit_nothing

TRANSCRIPT_PATH="$(rembric_transcript_path_from_stdin_json "$INPUT")"
FACTS=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  FACTS="$(rembric_session_facts "$PARSER" "$TRANSCRIPT_PATH" 2>/dev/null || true)"
fi

# A turn that only talked has nothing worth summarising. Gated on WORK rather
# than on the payload being empty: the extraction also emits the final exchange,
# which is present on every turn and would make this condition never fire.
rembric_session_has_work "$PARSER" "$TRANSCRIPT_PATH" || _emit_nothing
[ -z "$FACTS" ] && _emit_nothing

read -r -d '' RUBRIC <<'EOF' || true
rembric: this turn is done and the session has no curated summary. Call memory.session_summary({title≤100, summary}) now, covering: Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files.
Write the reasons and the evidence, not just the outcomes — the code already records what changed, never why it beat the alternative nor what you actually verified. Say what was left unfinished; silence there reads as "everything is done".
Ground it in these extracted facts rather than recollection:
EOF

if [ "${#FACTS}" -gt "$RBR_NUDGE_MAX_FACTS_CHARS" ]; then
  FACTS="…[earlier facts omitted]
${FACTS: -$RBR_NUDGE_MAX_FACTS_CHARS}"
fi

PAYLOAD="$(printf '%s\n%s' "$RUBRIC" "$FACTS")"
PAYLOAD_ESC="$(rembric_json_escape "$PAYLOAD")"

printf '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"%s"}}' "$PAYLOAD_ESC"
