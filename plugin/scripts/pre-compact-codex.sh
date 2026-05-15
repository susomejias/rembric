#!/usr/bin/env bash
# PreCompact hook for Codex: nudge the model to persist a session summary
# before the next turn is compacted. Codex hooks are command-only (no
# direct mcp_tool support yet), so we emit a stdout instruction the agent
# will see at compaction time.
set -u
trap 'exit 0' ERR
echo '[rembric] Compaction imminent — call memory.session_summary({auto:true}) now so the next session can recover via memory.context.'
exit 0
