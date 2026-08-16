#!/usr/bin/env bash
# Stop hook — Claude Code + Codex CLI. Fires once per assistant turn on both
# clients, replacing the pair of per-turn raw-transcript POST and
# counter-driven end-of-turn reminder scripts this change retires: this hook
# reports whether the turn used a tool and caches whatever notice lines the
# server returns for prompt-nudge.sh to print at the start of the NEXT turn
# (session-nudges). It writes NOTHING a host could treat as feedback on the
# turn — no hookSpecificOutput, no plain text — because Claude Code's Stop
# runner appends a hook's additionalContext to the array it returns as
# blockingErrors, and an unguarded reminder there re-fired on 141 consecutive
# continuations (plugin-session-protocol). Codex still requires `{}` JSON.
#
# Usage: stop-report.sh [agent-name]
#   hooks.json       → "claude-code"  — MUST emit NOTHING on stdout
#   hooks.codex.json → "codex-cli"    — MUST emit `{}` JSON on stdout
set -u
trap 'exit 0' ERR

# 256 KB: the cold-offset scan bound (session-nudges D4a) — bounded rather
# than exact, which is what keeps this off the cost curve the deleted
# counter-nudge script sat on (~0.5s of jq per firing, 790ms measured on 8.36 MB).
COLD_SCAN_MAX_BYTES=262144

AGENT="${1:-${REMBRIC_AGENT:-claude-code}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"

_emit_nothing() {
  # Codex expects a JSON object even when there is nothing to say.
  [ "$AGENT" = "codex-cli" ] && printf '{}'
  exit 0
}

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

# Decided BEFORE the transcript is touched: a continuation costs process
# start and nothing else (plugin-session-protocol).
[ "$(rembric_stop_hook_active_from_stdin_json "$INPUT")" = "true" ] && _emit_nothing

SESSION_ID="$(rembric_session_id_from_stdin_json "$INPUT")"
CWD="$(rembric_cwd_from_stdin_json "$INPUT")"
TRANSCRIPT_PATH="$(rembric_transcript_path_from_stdin_json "$INPUT")"
[ -z "$CWD" ] && CWD="$PWD"
SLUG="$(rembric_read_project_slug "$CWD")"

if [ -z "$SESSION_ID" ] || [ -z "$SLUG" ]; then
  _emit_nothing
fi

# Per-host marker pinned in design.md D4/D4a: Claude Code's tool-use events
# carry "type":"tool_use"; Codex's carry "function_call" (also matching
# mcp_tool_call, which contains the same substring).
case "$AGENT" in
  codex-cli) MARKER='"function_call"' ;;
  *) MARKER='"type":"tool_use"' ;;
esac

USED_TOOLS="false"
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  CURRENT_BYTES="$(wc -c <"$TRANSCRIPT_PATH" 2>/dev/null | tr -d '[:space:]')"
  case "$CURRENT_BYTES" in '' | *[!0-9]*) CURRENT_BYTES="" ;; esac
  OFFSET="$(rembric_scan_offset "$SESSION_ID")"
  case "$OFFSET" in '' | *[!0-9]*) OFFSET="" ;; esac
  if [ -n "$CURRENT_BYTES" ]; then
    if [ -n "$OFFSET" ] && [ "$OFFSET" -le "$CURRENT_BYTES" ]; then
      TAIL_ARG="+$((OFFSET + 1))"
    else
      # Cold offset (new process, or a shrunk/rotated file): scan at most
      # the last COLD_SCAN_MAX_BYTES rather than the whole transcript.
      TAIL_ARG="$COLD_SCAN_MAX_BYTES"
    fi
    # Streamed, not captured: `DELTA="$(tail …)"` materialised the whole delta
    # in the shell and then scanned it with `case`, which is the one unbounded
    # path here (COLD_SCAN_MAX_BYTES bounds only the cold branch). Measured on
    # 8 MB: 111ms → 4.4ms with no match, 134ms → 2.1ms with an early one.
    if tail -c "$TAIL_ARG" "$TRANSCRIPT_PATH" 2>/dev/null | grep -qF -m1 -- "$MARKER"; then
      USED_TOOLS="true"
    fi
    rembric_scan_offset_set "$SESSION_ID" "$CURRENT_BYTES"
  fi
fi

BODY="{\"usedTools\":${USED_TOOLS}"
FIRST_PROMPT="$(rembric_first_prompt_take "$SESSION_ID")"
if [ -n "$FIRST_PROMPT" ]; then
  BODY="${BODY},\"title\":\"$(rembric_json_escape "$FIRST_PROMPT")\""
fi
BODY="${BODY}}"

LINES="$(rembric_turn_report "/api/${SLUG}/sessions/${SESSION_ID}/turn" "$BODY")"
if [ -n "$LINES" ]; then
  rembric_pending_write "$SESSION_ID" "$LINES"
fi

_emit_nothing
