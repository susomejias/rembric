#!/usr/bin/env bash
# End-of-turn summary reminder — Claude Code + Codex CLI.
#
# Rationale in design.md D4. Separate from stop-sync.sh, which stays async: an
# async hook is fire-and-forget by the host's contract and so cannot contribute
# feedback to the turn at all.
set -u
trap 'exit 0' ERR

SUMMARY_NUDGE_EVERY=10
# Injected context, not stored content, so a much tighter bound than the stored
# body's 10 000. Tail-kept like every other layer — the later facts are the ones
# this turn produced. Guarded by invariants.test.ts.
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

# Unconfigured means the MCP tools are not reachable either, so a reminder to call
# one is noise. (prompt-nudge.sh has no such guard — an earlier version of this
# comment claimed every other hook did.)
if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
  _emit_nothing
fi

RAW_SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
COUNT="$(rembric_turn_count_peek rembric-turnnudge "$RAW_SESSION_ID")"
case "$COUNT" in
  # Fails CLOSED, matching prompt-nudge.sh: 0 would satisfy the modulo below.
  '' | *[!0-9]*) _emit_nothing ;;
esac
# NOT `COUNT -eq 1`: prompt-nudge.sh already fires on turn 1 as protocol, so
# including it here reminded twice on the one turn with the least to extract.
[ $((COUNT % SUMMARY_NUDGE_EVERY)) -eq 0 ] || _emit_nothing

TRANSCRIPT_PATH="$(rembric_transcript_path_from_stdin_json "$INPUT")"

# Parse ONCE, then answer both questions from the stream. Asking them separately
# re-read the transcript and put ~0.5s of jq on this synchronous path.
RAW="$(rembric_session_facts_raw "$PARSER" "$TRANSCRIPT_PATH" 2>/dev/null || true)"

# An empty stream means the turn only read or only talked: nothing worth
# summarising, so nothing to remind about.
[ -z "$RAW" ] && _emit_nothing

FACTS="$(rembric_facts_from_raw "$PARSER" "$TRANSCRIPT_PATH" "$RAW" 2>/dev/null || true)"
# Redact the WHOLE payload: commands and file paths carry <private> spans as
# readily as the exchange does, and this path bypasses _rembric_truncate_transcript
# (the stored path's redaction point) because it uses its own tighter bound.
FACTS="$(rembric_redact_private "$FACTS")"
[ -z "$FACTS" ] && _emit_nothing

read -r -d '' RUBRIC <<'EOF' || true
rembric: this turn is done. Call memory.session_summary({title≤100, summary}) now — the write REPLACES the stored summary, so send the session's CURRENT COMPLETE state, current state first: Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files.
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
