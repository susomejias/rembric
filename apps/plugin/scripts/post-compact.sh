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
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_read_project_slug "$CWD")"

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

cat <<'PROTOCOL'
rembric: This session resumes from a compaction. BEFORE continuing:
1. Call memory.session_get to read the stored summary.
2. Call memory.session_summary({title, summary}) with the CURRENT COMPLETE state, brought up to date — this REPLACES the stored value.
   - title: ≤100 chars, descriptive of the work (not generic, not the cwd).
   - summary: ≤10000 chars. Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):
## Goal
## Accomplished
## Decisions+why
## Verified+how
## Unfinished+why
## Files
3. Still missing detail? Call memory.context or memory.search.
4. Only then, continue with the user's request.
PROTOCOL

exit 0
