#!/usr/bin/env bash
# SessionStart hook: registers the host agent's session in Rembric.
#
# Usage: session-start.sh [agent-name]
#   agent-name defaults to $REMBRIC_AGENT or "unknown".
#   Each per-client hook manifest passes its own value:
#     hooks.json       → "claude-code"
#     hooks.codex.json → "codex-cli"
#
# 1. Reads `session_id` and `cwd` from hook stdin JSON and publishes the host
#    binding (rembric_host_binding_publish) for every source.
# 2. Resolves the session's project once (rembric_session_project): the nearest
#    `.rembric`, then REMBRIC_PROJECT_SLUG, then the repository fingerprint.
# 3. POSTs `/api/<slug>/sessions {id, cwd, agent}` to create or upsert the row.
# 4. POSTs `/api/<slug>/sessions/<id>/resume`, which returns an ended or
#    abandoned row to `active` and is a no-op on one that is already active.
# 5. Emits the deferred-tools hint (prompt-search.sh owns the turn-1 recall
#    line), plus the notice for an unbound, ambiguous, unresolvable or
#    conflicting repository.
#
# Failure modes (missing slug, server unreachable, malformed input) all
# fall through to a skip — the host session continues.
set -u
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

AGENT="${1:-${REMBRIC_AGENT:-unknown}}"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
rembric_host_binding_publish "$SESSION_ID"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"

SLUG="$(rembric_session_project "$SESSION_ID" "$CWD")"

if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ]; then
  ID_ESC="$(rembric_json_escape "$SESSION_ID")"
  CWD_ESC="$(rembric_json_escape "$CWD")"
  AGENT_ESC="$(rembric_json_escape "$AGENT")"
  CREATED="$(rembric_session_ensure "/api/${SLUG}/sessions" \
    "{\"id\":\"${ID_ESC}\",\"cwd\":\"${CWD_ESC}\",\"agent\":\"${AGENT_ESC}\"}")"
  # Latched on the FIRST ensure for this session id — prompt-nudge.sh (a
  # different process) reads it back to gate the resumed-process read line.
  rembric_resumed_mark "$SESSION_ID" "$CREATED"
  # The mirror latch: gates the session-opening line (session-nudges).
  rembric_created_mark "$SESSION_ID" "$CREATED"
  # Ensure-then-resume, in that order: a row purgeEmpty removed is recreated by
  # the ensure and the resume then no-ops against it. Never gated on `source` —
  # no host reports a resume on a cold start, which is the case this repairs.
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/resume" '{}'
fi

NUDGE='rembric: If Rembric memory tools are deferred, load them via tool search before calling them.'
NOTICE="$(rembric_session_project_notice "$SESSION_ID")"
NOTICE="${NOTICE%$'\n'}"
if [ -z "$NOTICE" ]; then
  printf '%s\n' "$NUDGE"
  exit 0
fi
# Plain stdout reaches only the model; systemMessage is what both hosts show the user.
CONTEXT="${NOTICE}"$'\n''Tell the user about this in your first reply.'
[ -n "$SLUG" ] && CONTEXT="${CONTEXT}"$'\n'"${NUDGE}"
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
  "$(rembric_json_escape "$NOTICE")" "$(rembric_json_escape "$CONTEXT")"
exit 0
