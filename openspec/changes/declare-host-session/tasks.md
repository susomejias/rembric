## 1. Contract

- [x] 1.1 proposal.md and design.md (D1–D7)
- [x] 1.2 Delta specs: mcp-api, sessions, http-api (server unit); mcp-bridge, opencode-plugin, pi-plugin (JS unit); plugin-session-protocol, claude-code-plugin, codex-distribution, hermes-agent-plugin (hooks/Python unit)

## 2. Server (W1)

- [x] 2.1 `X-Rembric-Session` read into `RequestContext.declaredSessionId` (D1)
- [x] 2.2 One helper for the honoured-declared then explicit steps; used by every listed handler (D2, D3)
- [x] 2.3 `memory.session_start` adopts an honoured declared session (D3)
- [x] 2.4 Tests through the MCP boundary: honoured beats a different explicit id; foreign, other-project, ended and deleted declarations are ignored; malformed is ignored; resume unchanged

## 3. JavaScript (W2)

- [x] 3.1 `rembric-host-binding.mjs` (D4, D6, D7)
- [x] 3.2 Bridge sends the header per request (D6)
- [x] 3.3 opencode publishes and removes the root session for its process (D5)
- [x] 3.4 Pi sets the header directly (D5)

## 4. Shell and Python (W3)

- [x] 4.1 `_api.sh` publish and remove; `session-start.sh` for every source, `session-end.sh` (D4, D5)
- [x] 4.2 Hermes publishes and removes for its process (D5)
- [x] 4.3 Shared layout fixture across bash, Python and JS

## 5. Verification

- [ ] 5.1 Full suite, lint, typecheck; mutation checks on every new guard
- [ ] 5.2 E2E against the local dev server: two concurrent Claude Code sessions in one repo, `/clear` in one of them
- [ ] 5.3 Independent verifier (Risk items 2, 3, 5)
