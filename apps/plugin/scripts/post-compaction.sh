#!/usr/bin/env bash
# PostCompact hook — shared by Claude Code and Codex CLI.
#
# Fires AFTER the compactor has produced its summary. stdin carries
# `compaction_summary` (Claude Code; possibly `compactionSummary` for
# Codex) — the model-authored compressed text we want to persist
# verbatim. This is the highest-quality summary we can capture because
# it was crafted by the same model that just compressed the conversation.
#
# stdout: NONE. PostCompact stdout is "side effects only" — NOT injected
# into the model's context. The model already has the summary in its
# context naturally; we don't echo it back.
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
COMPACTION_SUMMARY="$(rembric_compaction_summary_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_read_project_slug "$CWD")"

if [ -z "$SESSION_ID" ] || [ -z "$SLUG" ]; then
  exit 0
fi

if [ -n "$COMPACTION_SUMMARY" ]; then
  SUMMARY_ESC="$(rembric_json_escape "$COMPACTION_SUMMARY")"
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" \
    "{\"summary\":\"${SUMMARY_ESC}\",\"final\":false}"
else
  # Degraded mode — stdin lacks compaction_summary. Touch the row with
  # an empty body; server precedence preserves any prior summary.
  printf '[rembric] PostCompact: missing compaction_summary on stdin; posting empty body\n' >&2
  rembric_post "/api/${SLUG}/sessions/${SESSION_ID}/summary" "{}"
fi

exit 0
