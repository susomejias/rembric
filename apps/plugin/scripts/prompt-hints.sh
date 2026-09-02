#!/usr/bin/env bash
# UserPromptSubmit hook — Claude Code + Codex CLI. The dedicated entity-recall
# transport (`proactive-entity-recall`, D1′).
#
# Deliberately a SEPARATE script from prompt-search.sh, not an addition to it:
# `claude-code-plugin` publishes that the fixed-line hook performs no relevance
# query and emits byte-identical text regardless of the corpus. That property is
# worth keeping, so it stays intact and this script carries the one bounded,
# best-effort request instead.
#
# Runs at turn START, before the model composes its first answer, so a hint about
# the subject of THIS prompt reaches the model without costing it a cold turn.
# Silence is a correct outcome: no credentials, no slug, no session, a prompt with
# no indexed entity, or any failure at all — the hook never blocks the model and
# never exits non-zero.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
[ -z "$INPUT" ] && exit 0

PROMPT="$(rembric_prompt_from_stdin_json "$INPUT")"
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
SLUG="$(rembric_read_project_slug)"

# Silent by design: an unconfigured install hits this on every prompt, and
# rembric_post_lines already names a real transport failure.
if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
  exit 0
fi
if [ -z "$SLUG" ] || [ -z "$SESSION_ID" ] || [ -z "$PROMPT" ]; then
  exit 0
fi

# Client-side redaction before transport: strip <private> spans, then cap the
# payload. rembric_json_escape is argument-based (it never reads stdin), so it is
# called directly; escaping first makes the prompt one line, which lets a
# line-oriented excision see every span whole. sed has no lazy match and a span
# may itself contain '<', hence the awk scan: it takes the shortest closing tag
# and redacts through end-of-text on an unclosed span, like the core's twin.
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
[ -z "$REDACTED_PROMPT" ] && exit 0

rembric_recall_hints "/api/${SLUG}/sessions/${SESSION_ID}/recall-hints" \
  "{\"prompt\":\"${REDACTED_PROMPT}\"}"
exit 0
