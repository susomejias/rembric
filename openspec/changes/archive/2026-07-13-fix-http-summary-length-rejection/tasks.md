# Tasks

## 1. Decide the wire-guard approach (design D2)

- [x] 1.1 Read the existing "authenticated HTTP surface MUST bound request body size" requirement (`http-api` spec) + its implementation to confirm whether a transport byte-limit already guards DoS. **Found: it does not for `/api/*`.** `http.ts`'s `maxBodyBytes`/`readJsonBody` guard is gated to `/mcp` only (line ~193-194); `/api/<slug>/sessions*` falls through to Hono's unbounded `c.req.json()` (line 203) — a pre-existing spec/implementation mismatch (see 6.3). Option B is therefore NOT free → **Option A adopted**.
- [x] 1.2 Recorded in design.md's Open Questions: `summary` zod max 20_000→40_000, `title` zod max 100→200; `truncateSummary`/new `truncateTitle` keep the effective cuts at `SUMMARY_MAX_CHARS`/`TITLE_MAX_LENGTH` unchanged. `truncateTitle` is a hard-cut, no suffix.

## 2. Server: truncate-not-reject on the HTTP path

- [x] 2.1 `apps/server/src/server/api-router.ts`: raised `sessionSummarySchema`/`sessionEndSchema` `summary` max 20_000→40_000 and `title` max 100→200.
- [x] 2.2 Added `truncateTitle` (hard-cut at `TITLE_MAX_LENGTH=100`) in `apps/server/src/services/agent-sessions.ts`; applied in both `/summary` and `/end` handlers.
- [x] 2.3 Confirmed: `apps/server/src/mcp/session-tools.ts` uses its own zod schema keyed on `SUMMARY_MAX_CHARS` (10000), untouched — MCP path still rejects.
- [x] 2.4 Confirmed: no DB migration needed.

## 3. Plugin: log the HTTP error body (diagnosability)

- [x] 3.1 `apps/plugin/.hermes-plugin/__init__.py` `_api_request`: catches `HTTPError` explicitly, reads and logs the response body. Verified live against a real 400 response (`body={"ok": false, "code": "invalid_input", ...}`) and a real 200 (logs nothing).
- [x] 3.2 Parity applied: `apps/plugin/.opencode-plugin/plugin.ts` (`rembricPost`) now logs `res.text()` on `!res.ok`; `apps/plugin/scripts/_api.sh` (`rembric_post`) rewritten to capture the HTTP status via `curl -w` and log the body on non-2xx (previously used `-f` + `/dev/null`, which discarded the body entirely).

## 4. Tests

- [x] 4.1 Added to `apps/server/src/server/api-router.test.ts`: 20_001-chars-now-truncates, emoji-at-cap summary, 40_001 wire-DoS, over-length title truncates, emoji-at-cap title, 201-char title wire-DoS. Also added dedicated `truncateSummary`/`truncateTitle` unit tests in `apps/server/src/services/agent-sessions.test.ts`.
- [x] 4.2 Replaced the old "400 invalid_input on summary > 20_000" test with the new 40_000-boundary version; added the 20_001-now-succeeds case as its own test.
- [x] 4.3 No existing Hermes test asserted the old stderr format (checked); none needed updating.
- [x] 4.4 (found during 4.1, not pre-planned) The emoji-title test caught a REAL surrogate-pair-splitting bug: naive `.slice(0, N)` on a string can cut between a UTF-16 surrogate pair, leaving a lone high surrogate that `better-sqlite3` corrupts on write/read (confirmed: 1 lone surrogate → 3 garbage chars on round-trip). Fixed with `sliceWithoutSplittingSurrogatePair` in `agent-sessions.ts`, used by both `truncateSummary` (pre-existing latent bug, never triggered by prior ASCII-only tests) and the new `truncateTitle`.

## 5. Verification

- [x] 5.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all green (1100 server/plugin tests + 66 Hermes, up from 1091 — 9 new tests, 0 failures).
- [x] 5.2 e2e confirmed against a real running `dev:docker:up` server + SQLite: POSTed the exact production-reproducing payload (summary at 20001 UTF-16 units, title at 101 with emoji straddling the cap) to `/summary` → `HTTP_STATUS:200` (was `400` pre-fix), persisted `summary_len=10000`, `title_len=99` (surrogate-safety back-off, verified uncorrupted via read-only `sqlite3` query). Repeated against `/end` → `200`.
- [x] 5.3 No manual action needed — release-please handles version bumps automatically on merge.

## 6. Follow-ups (NOT in scope here — documented for a later change)

- [ ] 6.1 `openspec/specs/http-api/spec.md` requirement "Sessions registered via HTTP MUST integrate with the SessionRouter…" still says MCP tools "fall back to the **most-recently-active** row … whose `status = 'active'`". That is stale after `fix-cross-session-misattribution` (archived today), which changed `findActiveForTransport` to return `undefined` when >1 active row matches (never-guess). The `sessions` spec was synced but this `http-api` requirement was not. Open a separate change to re-sync it. (Surfaced while diagnosing this bug; deliberately left out of this change's scope.)
- [ ] 6.2 (Optional, defense-in-depth) Evaluate switching plugin-side transcript truncation to UTF-16-aware measurement so raw payload bytes are bounded consistently with the server — only worthwhile if a byte-level body-size limit is adopted (design D2 option B).
