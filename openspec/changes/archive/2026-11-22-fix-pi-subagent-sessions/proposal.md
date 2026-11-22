## Why

Pi processes that are not a primary conversation (RPC-driven children, spawner-declared sub-agents, pi-subagents children) registered their own Rembric session rows. Every delegated task surfaced as a top-level Pi session titled with the delegated prompt, and interrupted ones lingered as ghost rows.

## What Changes

- The Pi extension marks non-primary pi processes as sub-agents through the shared core's `markSubAgent`, suppressing automatic session persistence while keeping every MCP tool available.
- `REMBRIC_TRACK_SESSION=1` forces registration as an explicit operator opt-in.

## Capabilities

### Modified Capabilities

- `pi-plugin`: adds the requirement that non-primary pi processes suppress session lifecycle persistence.

## Impact

`apps/plugin/.pi-plugin/` only. Shipped in `3c5f5187`, `42f7d14e` and `52897162`.
