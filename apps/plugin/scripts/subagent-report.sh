#!/usr/bin/env bash
# PreToolUse(SubagentHandback) + SubagentStop hook — Claude Code + Codex CLI.
# Forwards a subagent's report to the parent session's learnings route and
# never reaches the model.
#
# Usage: subagent-report.sh [agent-name]
#   hooks.json       → "claude-code"  — MUST emit NOTHING on stdout
#   hooks.codex.json → "codex-cli"    — MUST emit `{}` JSON on stdout, on every path
set -u

AGENT="${1:-${REMBRIC_AGENT:-claude-code}}"
[ "$AGENT" = "codex-cli" ] && trap 'printf "{}"' EXIT
trap 'exit 0' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_api.sh
source "${SCRIPT_DIR}/_api.sh"
# shellcheck source=./_transcript.sh
source "${SCRIPT_DIR}/_transcript.sh"

INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

rembric_subagent_report "$AGENT" "$INPUT"
exit 0
