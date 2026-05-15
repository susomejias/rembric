#!/usr/bin/env bash
# Fires right after context compaction. Tells the agent to reload state.
# Cost: ~20 tokens.
set -u
trap 'exit 0' ERR
echo '[rembric] Context just compacted. Call memory.context to reload recent observations before continuing.'
exit 0
