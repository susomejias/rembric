#!/usr/bin/env bash
# SessionStart hook: registers the host agent's session in Rembric.
#
# Usage: session-start.sh [agent-name]
#   agent-name defaults to $REMBRIC_AGENT or "unknown".
#   Each per-client hook manifest passes its own value:
#     hooks.json       → "claude-code"
#     hooks.codex.json → "codex-cli"
#
# 1. Reads `session_id` and `cwd` from hook stdin JSON.
# 2. Resolves the Rembric project from `${cwd}/.rembric` (PROJECT_SLUG).
# 3. POSTs `/api/<slug>/sessions {id, cwd, agent}` to create or upsert the row.
# 4. Emits a nudge so the agent reloads memory.context if relevant.
#
# Failure modes (missing slug, server unreachable, malformed input) all
# fall through to a silent skip + nudge — the host session continues.
set -u
trap 'exit 0' ERR

# TEMP DIAGNOSTIC — pair with the one in session-stop.sh to confirm which
# hooks Codex 0.130.0 actually executes. Remove once diagnosed.
echo "$(date -u +%FT%T) session-start.sh fired argv=$* pid=$$" >> /tmp/codex-hooks-fire.log 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

AGENT="${1:-${REMBRIC_AGENT:-unknown}}"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"

SLUG="$(rembric_read_project_slug "$CWD")"

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ]; then
  ID_ESC="$(rembric_json_escape "$SESSION_ID")"
  CWD_ESC="$(rembric_json_escape "$CWD")"
  AGENT_ESC="$(rembric_json_escape "$AGENT")"
  rembric_post "/api/${SLUG}/sessions" \
    "{\"id\":\"${ID_ESC}\",\"cwd\":\"${CWD_ESC}\",\"agent\":\"${AGENT_ESC}\"}"
fi

echo 'rembric: If this is a continuation of recent work, call memory.context before responding.'
exit 0
