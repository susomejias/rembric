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
#   3. server-side entity hints (proactive-entity-recall): a synchronous
#      recall-hints POST whose `lines` are echoed after the local nudges —
#      best-effort, silent without server credentials or a resolvable slug.
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

# 3. Server-side entity hints: run ONLY when the hook carries server
#    credentials (hooks.json injects them), the project resolves a slug,
#    and a prompt+session exist — otherwise silence, like every other
#    best-effort call here.
SLUG="$(rembric_read_project_slug)"
if [ -n "${REMBRIC_SERVER_URL:-}" ] && [ -n "${REMBRIC_API_TOKEN:-}" ] &&
  [ -n "$SLUG" ] && [ -n "$SESSION_ID" ] && [ -n "$PROMPT" ]; then
  # Bash twin of the core's stripPrivateTags+slice: escape first so the
  # prompt is a single line (newlines are \n literals), excise every
  # <private> span with an awk lazy scan (sed has no lazy match, and a
  # span may contain '<'), then cap at 500 chars.
  # rembric_json_escape is argument-based (never reads stdin), so the
  # escape cannot ride the pipeline — call it directly, then redact.
  ESCAPED_PROMPT="$(rembric_json_escape "$PROMPT")"
  REDACTED_PROMPT="$(printf '%s' "$ESCAPED_PROMPT" |
    awk '{
            s = $0; out = ""
            while ((i = index(s, "<private>")) > 0) {
              out = out substr(s, 1, i - 1) "[REDACTED]"
              s = substr(s, i + 9)
              j = index(s, "</private>")
              if (j == 0) { s = ""; break }
              s = substr(s, j + 10)
            }
            print out s
          }')"
  REDACTED_PROMPT="${REDACTED_PROMPT:0:500}"
  rembric_recall_hints "/api/${SLUG}/sessions/${SESSION_ID}/recall-hints" \
    "{\"prompt\":\"${REDACTED_PROMPT}\"}"
fi
exit 0
