#!/usr/bin/env bash
# UserPromptSubmit hook — Claude Code + Codex CLI. Runs on EVERY prompt
# (matcher-less; Codex ignores the manifest matcher anyway, and Claude
# Code's registration was changed to match, since first-prompt detection
# needs to see every prompt too, not just keyword-matching ones) and
# self-filters internally for two independent triggers on one line each:
#   1. a recall keyword anywhere in the prompt (any turn)
#   2. the session's first prompt (relevance prefetch), tracked by its own
#      per-session turn counter — separate from prompt-nudge.sh's counter,
#      so the two scripts' independent cadences never double-increment.
# Keyword pattern + first-prompt text MUST stay in sync with
# test/nudge-fixtures.json.
set -u
trap 'exit 0' ERR

FIRST_PROMPT_NUDGE='rembric: New session — call memory.context with focus set to this prompt before responding, to surface relevant prior work.'
RECALL_NUDGE='rembric: User intent: recall. Call memory.search with the user keywords before responding.'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
PROMPT="$(rembric_prompt_from_stdin_json "$INPUT")"
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"

COUNT="$(rembric_turn_count rembric-relevance-prefetch "$SESSION_ID")"
FIRST_TURN=0
case "$COUNT" in
  '' | *[!0-9]*) : ;; # unreadable counter — fail closed on first-turn detection only
  *) [ "$COUNT" -eq 1 ] && FIRST_TURN=1 ;;
esac

KEYWORD_MATCH=0
if [ -n "$INPUT" ] && [ -n "$PROMPT" ]; then
  if printf '%s' "$PROMPT" | grep -qiE 'remember|recall|acuérdate|qué hicimos|what did we do'; then
    KEYWORD_MATCH=1
  fi
else
  # Unparseable/empty stdin falls through to the keyword nudge (fail open).
  KEYWORD_MATCH=1
fi

[ "$FIRST_TURN" -eq 1 ] && echo "$FIRST_PROMPT_NUDGE"
[ "$KEYWORD_MATCH" -eq 1 ] && echo "$RECALL_NUDGE"
exit 0
