#!/usr/bin/env bash
# Stop hook for Codex: gentle reminder to persist a session summary
# before the agent stops. Mirrors Claude Code's session-close protocol
# without depending on mcp_tool hook support.
set -u
trap 'exit 0' ERR
echo '[rembric] Session ending — if not done yet, call memory.session_summary so the next session starts informed.'
exit 0
