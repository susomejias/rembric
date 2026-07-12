## 1. Server: schema + persistence

- [x] 1.1 Migration `0018_agent_sessions_bridge_instance.sql` — nullable `bridge_instance_id` column + `sessions_token_bridge_instance_idx` index. Drizzle schema updated in `apps/server/src/db/schema/agent-sessions.ts`.
- [x] 1.2 `AgentSessionsRepository.findActiveByBridgeInstance(tokenId, bridgeInstanceId)` added, scoped to `status='active'`/`deletedAt IS NULL`/caller's `tokenId`.
- [x] 1.3 `AgentSessionsService`: `ensure`/`writeSummary`/`end` all accept and backfill `bridgeInstanceId` (set when provided and different from the existing value); new `findActiveByBridgeInstance` service method.
- [x] 1.4 Repository tests (4, `agent-sessions-repository.test.ts`) + service tests (7, `agent-sessions.test.ts`) covering token-scoping, resolution among several active sessions, and backfill-on-idempotent-hit.

## 2. Server: HTTP API acceptance of `bridgeInstanceId`

- [x] 2.1 `api-router.ts`: `bridgeInstanceIdSchema` (bounded-length opaque string) added to `sessionPostSchema`/`sessionSummarySchema`/`sessionEndSchema`; threaded to the service layer in all three handlers.
- [x] 2.2 HTTP-layer tests (2, `api-router.test.ts`): persists when present, `null` when omitted (backward compatible).

## 3. Server: session-resolution precedence

- [x] 3.1 `request-context.ts` gained `bridgeInstanceId: string | null`; `http.ts` reads `x-rembric-bridge-instance` and sets it in the per-request context (mirrors the existing `mcp-session-id` handling); `auth.ts` defaults it to `null` for the non-MCP HTTP-API auth path.
- [x] 3.2 `_shared.ts::resolveSessionId` and `memory-tools.ts::resolveActiveSessionId` both gained the new precedence step between the `SessionRouter` entry and the `(tokenId, projectId)` DB fallback, scoped to the caller's token, falling through silently on no match.
- [x] 3.3 Tests covering all three spec scenarios, on BOTH edited functions: `memory-tools.test.ts` (4 new tests, `memory.save`/`resolveActiveSessionId`) and `session-scope-resolution.test.ts` (3 new tests, `memory.save_prompt`/`resolveSessionId`).
- [x] 3.4 Regression check: full suite green (84 files, 1156 passed, 1 pre-existing skip) — no existing precedence test needed changes.

## 4. Shared correlation-file helper (bridge side)

- [ ] 4.1 In `apps/plugin/bin/rembric-bridge.mjs`: generate a random instance id (e.g. `crypto.randomUUID()`) once at startup, write it to `${TMPDIR:-/tmp}/rembric-bridge-instance/<sanitized-cwd>` (sanitize using the same non-alnum → `_` transform as `SAFE_ID` in `apps/plugin/scripts/prompt-nudge.sh`, reusing that pattern rather than inventing a new one), overwriting any existing file for that directory. Failure to write (unwritable `$TMPDIR`) SHALL NOT abort the bridge.
- [ ] 4.2 Forward the instance id as `--header X-Rembric-Bridge-Instance:<value>` to the `mcp-remote` spawn, alongside the existing `Authorization` header — only when the write in 4.1 succeeded.
- [ ] 4.3 Tests (`apps/plugin/test/rembric-bridge.test.ts` or sibling): assert the file is written with the expected path/sanitization, assert the header is included in the `mcp-remote` spawn args when the file write succeeds, assert graceful degradation (no header, no crash) when the write fails (e.g. mock an unwritable directory).

## 5. Shared correlation-file helper (client read side)

- [ ] 5.1 Add a small, single-purpose read helper (mirrors the existing `rembric-dotenv.mjs` single-source-of-truth discipline for the JS/TS side): given a cwd, return the correlation file's content or `null`. Used by the opencode plugin.
- [ ] 5.2 Bash equivalent for the shared hook scripts (`apps/plugin/scripts/_api.sh` or a new small function alongside it) — read-only, same path/sanitization convention as 4.1, used by Claude Code + Codex hook scripts.
- [ ] 5.3 Python equivalent inside `apps/plugin/.hermes-plugin/__init__.py` (a small private function, same convention) — used by the Hermes provider.
- [ ] 5.4 Cross-language fixture test (mirroring the existing `nudge-fixtures.test.ts`/redaction-fixtures pattern) asserting all three implementations compute the identical sanitized filename for the same cwd input, so they agree on where to look.

## 6. Claude Code + Codex hook scripts

- [ ] 6.1 `apps/plugin/scripts/session-start.sh`: read the correlation file via the helper from 5.2; include `bridgeInstanceId` in the `POST /sessions` body when present, omit when absent.
- [ ] 6.2 `apps/plugin/scripts/stop-sync.sh` (both Claude Code and Codex code paths) and `apps/plugin/scripts/session-end.sh`: same treatment for their respective `POST /summary` / `POST /end` calls.
- [ ] 6.3 Tests: extend the existing `apps/plugin/test/stop-sync.test.ts` / equivalent hook tests to assert the field is included when a correlation file is present and omitted when absent, without changing any other assertion in those files.

## 7. opencode plugin

- [ ] 7.1 `apps/plugin/.opencode-plugin/plugin.ts`: read the correlation file (via the helper from 5.1) at the points where `ensureSession`/`flushSessionSummary`/`disposeFlushFireAndForget` build their POST bodies; include `bridgeInstanceId` when present.
- [ ] 7.2 Tests: extend `plugin.test.ts` to assert the field appears in the relevant POST bodies when a correlation file is present, and is absent otherwise — without altering existing assertions.

## 8. Hermes provider

- [ ] 8.1 `apps/plugin/.hermes-plugin/__init__.py`: read the correlation file (via the helper from 5.3) in `initialize`, `on_session_switch`, and `on_session_end`; include `bridgeInstanceId` in their respective HTTP POST bodies when present.
- [ ] 8.2 Tests: extend the relevant `apps/plugin/.hermes-plugin/tests/*.py` files to cover both the present-file and absent-file cases for each of the three lifecycle methods.

## 9. Spec archive prerequisites

- [ ] 9.1 Confirm `openspec validate "fix-cross-session-misattribution" --strict` (or equivalent) passes before moving to archive.
- [ ] 9.2 Full test suite: `pnpm test` (TypeScript) and `pnpm run test:hermes-plugin` (Python) both green; `pnpm run typecheck` and `pnpm run lint` clean.

## 10. Mandatory e2e verification (per `rembric-plugin-development` skill)

- [ ] 10.1 **Operator-gated e2e**: against a live server (`pnpm run dev:docker:up` or the operator's own dev server), run two concurrent sessions of different clients (e.g. a Claude Code session and an opencode session, matching the exact scenario that surfaced this bug) under the same token+project, and confirm a `memory.session_summary` call from one never lands on the other's session row. This is the load-bearing verification for the entire change — do not archive without it actually passing live, not just via unit tests with fabricated headers.
- [ ] 10.2 Confirm graceful degradation: kill/skip the bridge (or otherwise ensure no correlation file exists) and confirm the existing (pre-change) fallback behavior still works — a single active session under a token still resolves correctly with no header present at all.
