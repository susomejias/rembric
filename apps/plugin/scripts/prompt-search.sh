#!/usr/bin/env bash
# Reminds the agent to search Rembric when the prompt matches recall keywords.
# Self-filters on stdin because Codex ignores the hook `matcher` (Claude
# honours it, so there the grep is a harmless re-check). Keyword pattern MUST
# stay in sync with the `matcher` in hooks/hooks.json + hooks/hooks.codex.json.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
PROMPT="$(rembric_prompt_from_stdin_json "$INPUT")"

if [ -n "$INPUT" ] && [ -n "$PROMPT" ]; then
  if ! printf '%s' "$PROMPT" | grep -qiE 'remember|recall|acuérdate|qué hicimos|what did we do'; then
    exit 0
  fi
fi
# Unparseable/empty stdin falls through to the nudge (fail open).

echo 'rembric: User intent: recall. Call memory.search with the user keywords before responding.'
exit 0
