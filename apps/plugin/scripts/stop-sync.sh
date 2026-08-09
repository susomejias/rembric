#!/usr/bin/env bash
# Stop hook — Claude Code + Codex CLI. Fires once per assistant turn on both
# clients (NOT once per session — see the claude-code-plugin spec's note on
# why a prior Stop hook was removed and why this one is safe: it never posts
# to /end and never transitions session status).
#
# Pure side effect: raw per-turn transcript sync to /summary. Claude Code
# omits `final` entirely (never sent as true); Codex sends `final:false`
# explicitly, so a per-turn sync never locks the column against the curated
# summary its SessionEnd may still write. Either way, a curated
# memory.session_summary (final:true) always wins via the server's
# last-final-wins precedence.
#
# Claude Code's transcript-format-and-POST work runs in a detached
# background subshell, stdout/stderr redirected to /dev/null so the host
# sees EOF on this process's output as soon as the parent exits (the
# classic shell daemonizing pattern — without the redirect, an inherited
# pipe FD in the child would keep the host waiting on it regardless of
# how fast the parent returns). hooks.json wires "async": true, but
# whether that flag itself decouples the Stop event from turn latency is
# unconfirmed, so this makes the script non-blocking on its own terms.
#
# Codex CLI stays synchronous — no documented async escape hatch, and
# MUST emit `{}` JSON on stdout before exit.
#
# Usage: stop-sync.sh [agent-name]
#   agent-name defaults to $REMBRIC_AGENT or "claude-code".
#   hooks.json       → "claude-code"  — MUST emit NOTHING on stdout
#   hooks.codex.json → "codex-cli"    — MUST emit `{}` JSON on stdout
#     (Codex docs: "Stop expects JSON on stdout when it exits 0.")
set -Eu

AGENT="${1:-${REMBRIC_AGENT:-claude-code}}"
PARSER="${AGENT//-/_}"
if [ "$AGENT" = "codex-cli" ]; then
  FINAL_JSON=',"final":false'
else
  FINAL_JSON=''
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

_sync() {
  trap 'exit 0' ERR
  # shellcheck source=./_api.sh
  source "${SCRIPT_DIR}/_api.sh"
  # shellcheck source=./_transcript.sh
  source "${SCRIPT_DIR}/_transcript.sh"

  local session_id cwd transcript_path slug summary title summary_esc title_esc
  session_id="$(rembric_session_id_from_stdin_json "$INPUT")"
  cwd="$(rembric_cwd_from_stdin_json "$INPUT")"
  transcript_path="$(rembric_transcript_path_from_stdin_json "$INPUT")"
  [ -z "$cwd" ] && cwd="$PWD"
  slug="$(rembric_read_project_slug "$cwd")"

  [ -z "$session_id" ] && return 0
  [ -z "$slug" ] && return 0
  [ -z "$transcript_path" ] && return 0
  [ -f "$transcript_path" ] || return 0

  # The formatter below keeps only user/assistant TEXT, so it discards the paths,
  # commands and exit statuses a handoff needs. Facts replace it where available.
  summary="$(rembric_session_facts "$PARSER" "$transcript_path" 2>/dev/null || true)"
  if [ -n "$summary" ]; then
    summary="$(_rembric_truncate_transcript "$summary")"
  else
    summary="$("rembric_format_transcript_${PARSER}" "$transcript_path" 2>/dev/null || true)"
  fi
  [ -z "$summary" ] && return 0
  title="$("rembric_extract_first_assistant_${PARSER}" "$transcript_path" 2>/dev/null || true)"
  summary_esc="$(rembric_json_escape "$summary")"
  if [ -n "$title" ]; then
    title_esc="$(rembric_json_escape "$title")"
    rembric_post "/api/${slug}/sessions/${session_id}/summary" \
      "{\"summary\":\"${summary_esc}\",\"title\":\"${title_esc}\"${FINAL_JSON}}"
  else
    rembric_post "/api/${slug}/sessions/${session_id}/summary" \
      "{\"summary\":\"${summary_esc}\"${FINAL_JSON}}"
  fi
}

if [ "$AGENT" = "codex-cli" ]; then
  trap '_emit_json' ERR
  _emit_json() {
    printf '{}'
    exit 0
  }
  _sync
  printf '{}'
else
  trap 'exit 0' ERR
  _sync >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

exit 0
