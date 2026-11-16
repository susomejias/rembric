#!/usr/bin/env bash
# PreToolUse hook (Claude Code + Codex CLI): before a file tool or shell command runs,
# ask the server for the memories linked to the files it names, once per file per
# session. Output is the documented JSON `additionalContext` or nothing — never a
# permission decision, never a non-zero exit, so the tool always runs.
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
if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
  exit 0
fi

stdin_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r "${1} // empty" 2>/dev/null || true
    return 0
  fi
  local raw
  raw="$(rembric_json_raw_string_field "$INPUT" "$2")"
  [ -z "$raw" ] && return 0
  rembric_json_decode_string "$raw"
  printf '%s' "$REMBRIC_JSON_DECODED"
}

# A sub-agent shares the parent's session id; recalling into it would spend the
# parent's dedupe on a context the parent never sees.
[ -n "$(stdin_field .agent_id agent_id)" ] && exit 0

SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi
SLUG="$(rembric_session_project "$SESSION_ID" "$CWD")"
[ -z "$SLUG" ] && exit 0
DIR="$(rembric_file_recall_dir "$SESSION_ID")"

case "$(stdin_field .tool_name tool_name)" in
Read | Edit | Write | MultiEdit) PATHS="$(stdin_field .tool_input.file_path file_path)" ;;
NotebookEdit) PATHS="$(stdin_field .tool_input.notebook_path notebook_path)" ;;
Bash) PATHS="$(rembric_command_paths "$(stdin_field .tool_input.command command)")" ;;
apply_patch) PATHS="$(rembric_patch_paths "$(stdin_field .tool_input.command command)")" ;;
*) exit 0 ;;
esac
[ -z "$PATHS" ] && exit 0

# One failed request means the server is down or too slow; the rest of this firing would only
# add its budget again, so the remaining files stay unclaimed for a later firing.
FAILED="${DIR}/failed-$$"
BLOCK=""
while IFS= read -r CANDIDATE; do
  [ -z "$CANDIDATE" ] && continue
  [ -e "${DIR}/exhausted" ] && break
  [ -e "$FAILED" ] && break
  REL="$(rembric_tracked_path "$CWD" "$CANDIDATE")"
  [ -z "$REL" ] && continue
  rembric_file_recall_claim "$DIR" "$REL" || continue
  SIBLINGS="$(rembric_sibling_paths_json "$CWD" "$REL")"
  BODY="{\"path\":\"$(rembric_json_escape "$REL")\""
  [ -n "$SIBLINGS" ] && BODY="${BODY},\"siblings\":${SIBLINGS}"
  BODY="${BODY}}"
  LINES="$(REMBRIC_POST_MAX_TIME="${REMBRIC_POST_MAX_TIME:-0.3}" \
    rembric_post_lines "/api/${SLUG}/sessions/${SESSION_ID}/file-recall" "$BODY" "${DIR}/exhausted" "$FAILED")"
  [ -z "$LINES" ] && continue
  if [ -n "$BLOCK" ]; then
    BLOCK="${BLOCK}"$'\n'"${LINES}"
  else
    BLOCK="$LINES"
  fi
done <<<"$PATHS"

[ -e "$FAILED" ] && { unlink "$FAILED" 2>/dev/null || true; }
[ -z "$BLOCK" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}' \
  "$(rembric_json_escape "$BLOCK")"
exit 0
