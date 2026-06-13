## Why

Rembric is multi-machine by construction: the server runs on one host (e.g. a VPS) and each client plugin is installed on a different machine (one per PC where the operator uses Rembric). When the operator asks any connected agent "how do I update Rembric?", there is no in-band, cross-client answer. Skills are a Claude-Code-only primitive, so they cannot serve Codex, opencode, or Hermes; and the real update paths live elsewhere — plugins update via the TUI installer (per client machine), the server updates via Docker (on its host). A read-only MCP tool is the only surface that reaches all four clients on demand, so it can act as the portable "skill" that hands back the update guidance.

## What Changes

- Add a new **read-only** MCP tool `memory.about` that returns update guidance as structured data, split by machine so the two version lines are never conflated (server `0.21.x` vs plugins `0.11.x` are independent release-please components):
  - **server axis**: the running `REMBRIC_VERSION` and the update path on the server host (`docker compose pull && docker compose up -d`). The server legitimately knows its own version because the tool executes there.
  - **plugins axis**: the canonical TUI-installer command(s) (`curl -fsSL .../install.sh | sh` and `… --action=update [--agent=…]`), with an explicit note that plugins live on each client machine which this server cannot see, so the operator runs the command on each machine.
- The tool takes no parameters, performs no side effects, does NOT detect installed clients, and does NOT diff versions. It delegates to the TUI installer and the Docker flow; it reimplements neither (honoring the "installer is the single install/maintenance path" contract).
- The tool MUST be guidance-only: it surfaces commands for the operator to run and MUST NOT execute `curl|sh` or `docker` itself; no client should auto-run them.
- Extend the MCP `initialize.instructions` block (`buildInstructions`) to **cite `memory.about`** as where to learn how to update, staying within the existing 800-char cap. This serves Claude Code and Codex (the clients that consume `instructions`). opencode and Hermes do not consume that block, so they discover the tool via its keyword-rich MCP manifest description; the Hermes `system_prompt_block` (hard ≤300-char cap, already saturated) is intentionally NOT modified.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-api`: adds a new requirement for the read-only `memory.about` tool (two-axis, guidance-only, no params, no side effects), and extends the existing `initialize.instructions` requirement to cite `memory.about` while preserving the 800-char cap.

## Impact

- `apps/server/src/mcp/server.ts` — register `memory.about` (alongside the existing `memory.doctor` registration).
- New handler for the tool (e.g. `apps/server/src/mcp/about-tool.ts`), reading `REMBRIC_VERSION` from `apps/server/src/version.ts` (already exported) and emitting the static installer/docker commands as constants.
- `apps/server/src/mcp/instructions.ts` + `apps/server/src/mcp/instructions.test.ts` — citation clause + cap assertion.
- No `apps/plugin/` change: the tool is delivered to every client by the server's MCP manifest; no plugin manifest, hook, or prompt-block edit is required.
- No database, no migration, no new dependency. Read-only with zero persistence: the append-only, scope-at-service, `topic_key`, and judgment-freshness invariants are NOT touched.
