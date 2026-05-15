#!/usr/bin/env bash
# Fires when the user's prompt matches recall keywords.
# Reminds the agent to search Rembric before answering.
# Cost: ~20 tokens.
set -u
trap 'exit 0' ERR
echo '[rembric] User intent: recall. Call memory.search with the user keywords before responding.'
exit 0
