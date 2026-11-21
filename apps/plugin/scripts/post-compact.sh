#!/usr/bin/env bash
# SessionStart (matcher:"compact") hook — Claude Code + Codex CLI. Its stdout
# is injected into the resumed model's context on both clients, so we use it
# to tell the model to persist the compact summary via memory.session_summary.
# Prefix `rembric:` keeps Codex's looks_like_json heuristic from flagging it.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
rembric_host_binding_publish "$SESSION_ID"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_session_project "$SESSION_ID" "$CWD")"

# Idempotent ensure, then resume. The ensure alone returns a terminal row
# untouched, so the resume is what recovers a row the stale sweep abandoned
# between the pre-compact moment and here.
if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ]; then
  ID_ESC="$(rembric_json_escape "$SESSION_ID")"
  CWD_ESC="$(rembric_json_escape "$CWD")"
  AGENT_ESC="$(rembric_json_escape "${1:-${REMBRIC_AGENT:-claude-code}}")"
  rembric_post "/api/${SLUG}/sessions" \
    "{\"id\":\"${ID_ESC}\",\"cwd\":\"${CWD_ESC}\",\"agent\":\"${AGENT_ESC}\"}"
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/resume" '{}'
fi

# The server releases its file-recall state on that resume; the local claims go too.
rembric_file_recall_reset "$SESSION_ID"

BLOCK="$(cat <<'PROTOCOL'
rembric: Resumed from a compaction. BEFORE continuing:
1. Call memory.session_get_batch({ ids: [sessionId] }) and read sessions[0] in full.
2. Call memory.session_summary({title, summary}) with the CURRENT COMPLETE state: sent `##` sections REPLACE their stored counterpart; omitted ones STAY.
   - title: ≤100 chars, not the cwd.
   - summary: ≤10000 chars. Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):
## Goal
## Accomplished
## Decisions+why
## Verified+how
## Unfinished+why
## Files
3. Missing detail? memory.context or memory.search.
4. Then continue.
PROTOCOL
)"

if [ -n "$SESSION_ID" ]; then
  READ_SYMBOLIC='ids: [sessionId]'
  READ_LITERAL="ids: [\"${SESSION_ID}\"]"
  WRITE_SYMBOLIC='memory.session_summary({title, summary})'
  WRITE_NAMED='memory.session_summary({sessionId, title, summary})'
  BLOCK="${BLOCK/"$READ_SYMBOLIC"/$READ_LITERAL}"
  BLOCK="${BLOCK/"$WRITE_SYMBOLIC"/$WRITE_NAMED}"
fi
printf '%s\n' "$BLOCK"

exit 0
