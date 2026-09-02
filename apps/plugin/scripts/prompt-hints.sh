#!/usr/bin/env bash
# Separate from prompt-search.sh on purpose: that hook publishes no network call and corpus-independent output.
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

if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
  exit 0
fi
if [ -z "$SLUG" ] || [ -z "$SESSION_ID" ] || [ -z "$PROMPT" ]; then
  exit 0
fi

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
