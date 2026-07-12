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

# Re-affirm the session row exists (idempotent ensure). This covers the
# edge case where the row was abandoned by the stale sweep between the
# pre-compact moment and the post-compact resume — re-create silently.
if [ -n "$SESSION_ID" ] && [ -n "$SLUG" ]; then
  ID_ESC="$(rembric_json_escape "$SESSION_ID")"
  CWD_ESC="$(rembric_json_escape "$CWD")"
  AGENT_ESC="$(rembric_json_escape "${1:-${REMBRIC_AGENT:-claude-code}}")"
  rembric_post "/api/${SLUG}/sessions" \
    "{\"id\":\"${ID_ESC}\",\"cwd\":\"${CWD_ESC}\",\"agent\":\"${AGENT_ESC}\"}"
fi

cat <<'PROTOCOL'
rembric: Esta sesión resume desde una compaction. ANTES de continuar:
1. Llamá memory.session_summary({title, summary}) con el compact summary que ves arriba.
   - title: ≤100 chars, descriptivo del trabajo real (no genérico, no el cwd).
   - summary: ≤10000 chars. Goal · Discoveries · Accomplished · Next Steps · Files.
2. Si el summary arriba no contiene el detalle que necesitás (file paths exactos, decisiones técnicas concretas, errores específicos previos), llamá memory.context o memory.search ANTES de responder.
3. Recién después, continuá con la petición del usuario.
PROTOCOL

exit 0
