#!/usr/bin/env bash
# SessionStart hook: gentle nudge for the agent to load recent memory.
#
# The active Rembric project is path-scoped by the plugin bridge
# (`bin/rembric-bridge.mjs`) before the MCP session is established — the
# agent does not need to call `project.use` itself.
set -u
trap 'exit 0' ERR
echo '[rembric] If this is a continuation of recent work, call memory.context before responding.'
exit 0
