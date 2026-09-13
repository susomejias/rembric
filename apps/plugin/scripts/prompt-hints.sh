#!/usr/bin/env bash
# Separate from prompt-search.sh on purpose: that hook publishes no network call and corpus-independent output.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"
# shellcheck source=./_transcript.sh
source "${SCRIPT_DIR}/_transcript.sh"

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

# Keep the ordering shared with transcript handling: redact raw text first
# (case-insensitive, multiline, unclosed spans), bound what can leave the
# process, then encode the bounded value for its JSON envelope.
REDACTED_PROMPT="$(rembric_redact_private "$PROMPT")"
REDACTED_PROMPT="${REDACTED_PROMPT:0:500}"
[ -z "$REDACTED_PROMPT" ] && exit 0
ESCAPED_PROMPT="$(rembric_json_escape "$REDACTED_PROMPT")"

# This hook runs at turn start, so it alone gets the 200ms budget; all other
# shared API calls retain `_api.sh`'s 3s default.
REMBRIC_POST_MAX_TIME=0.2 rembric_recall_hints "/api/${SLUG}/sessions/${SESSION_ID}/recall-hints" \
  "{\"prompt\":\"${ESCAPED_PROMPT}\"}"
exit 0
