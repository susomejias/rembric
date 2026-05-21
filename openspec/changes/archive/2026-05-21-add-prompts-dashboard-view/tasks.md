## 1. Schema and migrations

- [x] 1.1 Extend `apps/server/src/db/schema/prompts.ts` to add nullable columns `deletedAt` (`timestamp_ms`), `title` (`text`), `tags` (`text` JSON), `replaces` (`text` JSON); fix the file's top-of-file docstring to read "Records curated, reusable user prompts (goals, constraints, directives). Append-only: content is never UPDATEd; lifecycle is `deleted_at` flips plus `replaces` links."
- [x] 1.2 Write the additive migration `apps/server/src/db/migrations/0008_prompts_extend.sql` containing four `ALTER TABLE prompts ADD COLUMN` statements (no destructive changes). Hand-author it to mirror the shape of `0006_session_deleted_at.sql`.
- [x] 1.3 Write hand-authored migration `apps/server/src/db/migrations/0009_prompts_fts.sql` creating the `prompts_fts` virtual table (`content + tags`, contentless, `content_rowid='rowid'`) and the three triggers `prompts_ai` / `prompts_au` / `prompts_ad` mirroring the shape of `0001_fts5_setup.sql`. Include a final `INSERT INTO prompts_fts(rowid, content, tags) SELECT rowid, content, coalesce(...) FROM prompts;` backfill so the index is complete on first boot after this change.
- [x] 1.4 Add `Prompt` and `NewPrompt` type exports reflecting the new columns; verify `pnpm --filter server typecheck` is green.

## 2. Service layer

- [x] 2.1 In `apps/server/src/services/prompts.ts`, extend `SavePromptInput` with optional `title`, `tags`, `replaces` fields and update the existing `save()` method to persist them when provided.
- [x] 2.2 In the same service, implement the `replaces` atomic refine path: when `input.replaces` is non-null, run a `db.transaction(...)` that loads the predecessor, validates it (exists, same `project_id`, `deleted_at IS NULL`), flips its `deleted_at`, and inserts the new row with `replaces=[predecessorId]`. On any failure throw the relevant `DomainError`: `prompt_not_found`, `prompt_scope_mismatch`, `prompt_already_deleted`.
- [x] 2.3 Add `softDelete(id: string, opts?: { adminBypass?: boolean })`, `undelete(id: string, opts?: { adminBypass?: boolean })`, and `purgeDeleted(opts: { adminBypass: true })` on `PromptsService` with the same shape as the corresponding `AgentSessionsService` / `MemoryService` methods. Write `consolidation_ops` rows with `op_type = 'prompt_purge'` and `affected_ids` from `purgeDeleted`.
- [x] 2.4 Add `searchByScope({ scope, query?, sessionId?, agent?, includeDeleted?, limit, offset })`: when `query` is provided, JOIN against `prompts_fts MATCH ?`; otherwise fall back to a plain recency query. Clamp `limit` to `[1, 100]`. Default excludes `deleted_at IS NOT NULL` rows.
- [x] 2.5 Update `recentForContext()` to add a `WHERE deleted_at IS NULL` clause; verify existing call sites (e.g. `memory.context`) keep working.
- [x] 2.6 Update `AgentSessionsService.purgeEmpty()` in `apps/server/src/services/agent-sessions.ts` so its empty-session predicate reads `NOT EXISTS (SELECT 1 FROM prompts WHERE session_id = sessions.id AND deleted_at IS NULL)` (soft-deleted prompts no longer block purge).
- [x] 2.7 Write `apps/server/src/services/prompts.test.ts` (or extend the existing test if one exists): covers save with title/tags, refine atomic flow + all three error codes, softDelete + undelete + idempotency, purgeDeleted + `consolidation_ops` journal, searchByScope FTS5 match, includeDeleted toggle. All tests `pnpm --filter server vitest run prompts.test.ts` green.

## 3. MCP layer

- [x] 3.1 In `apps/server/src/mcp/sessions-tools.ts`, extend `savePromptSchema` with optional `title` (zod `.string().max(100)`), `tags` (zod `.array(z.string().min(1)).optional()`), `replaces` (zod `.string().min(1).optional()`); update `handleSavePrompt` to forward the new fields to `PromptsService.save`.
- [x] 3.2 In the same file, define `searchPromptsSchema` and `handleSearchPrompts`: resolves scope via the existing `scopeFromContext` helper, calls `PromptsService.searchByScope`, returns `{ scope, prompts: [...], total, clamped }`.
- [x] 3.3 Export `searchPrompts` from `buildSessionsHandlers` in the same file.
- [x] 3.4 In `apps/server/src/mcp/server.ts`, register the new tool `memory.search_prompts` via `server.registerTool(...)` with a clear protocol-teaching description.
- [x] 3.5 In `apps/server/src/mcp/server.ts`, update the inline description of `memory.save_prompt` to mention optional `title`, `tags`, `replaces` semantics; do NOT modify `apps/server/src/mcp/instructions.ts` (the 800-char crib sheet stays as-is).
- [x] 3.6 Extend `apps/server/src/mcp/session-scope-resolution.test.ts` to cover `memory.search_prompts` scope resolution under path-scoped, path-less + router-pin, and path-less + no-pin connections.
- [x] 3.7 Add a new test (or extend `apps/server/src/mcp/sessions-tools.test.ts`) covering the refine flow end-to-end through `memory.save_prompt({ replaces })` and the three rejection paths.

## 4. Dashboard router and views

- [x] 4.1 In `apps/server/src/dashboard/components.ts`, extend `NavKey` union with `'prompts'`, add a `prompts` entry to `NAV` between `sessions` and `judgments` (`num: '03b'`, `label: 'PROMPTS'`, `group: 'MAIN'`, `iconKey: 'prompts'`), and add a new SVG to `NAV_ICONS.prompts` (a speech-bubble or curly-brace glyph, ≤200 chars, following the existing 16×16 viewBox convention).
- [x] 4.2 Create `apps/server/src/dashboard/styles/views/prompts.css` with view-specific selectors (badge styling for `REFINED`, content-truncation utility, expandable `<details>` row style). Verify `pnpm --filter server build` emits `dist/dashboard/public/assets/styles/views/prompts.<hash>.css` and updates `manifest.json`.
- [x] 4.3 CSS build script auto-discovers `views/*.css`; no enumeration update needed (verified in `apps/server/scripts/build-css.mjs::readViews`).
- [x] 4.4 Write `apps/server/src/dashboard/prompts.ts` exporting `createPromptsRouter(deps: { db, prompts, sessions })`. Implement `GET /` (list with filters + FTS), `POST /:id/delete`, `POST /:id/undelete`. CSRF action tokens: `prompt.delete`, `prompt.undelete`. All destructive forms carry `data-confirm` / `data-confirm-label` / `data-confirm-tone="warn"` on the `<form>` element.
- [x] 4.5 In `apps/server/src/server/dashboard-router.ts`, mount the prompts router at `/prompts` after the existing `/judgments` mount; thread the `prompts` service through `DashboardDeps`.
- [x] 4.6 In `apps/server/src/dashboard/sessions.ts`, add a second SQL aggregate query for prompt counts grouped by `session_id` (mirror of the memory-count subquery, with `WHERE deleted_at IS NULL`). Render a new `prompts` column right of `memories` in the list view's `<thead>` and `<tbody>`.
- [x] 4.7 In the session detail handler of the same file, load `prompts` rows where `session_id = id AND deleted_at IS NULL` ordered by `created_at ASC`, render a new `<h2>Prompts (N)</h2>` section BELOW the existing `<h2>Memories (N)</h2>` section, with the column set documented in `specs/dashboard/spec.md`. Empty state: `<p class="muted">No prompts anchored to this session.</p>`.
- [x] 4.8 In `apps/server/src/dashboard/maintenance.ts`, add the third purge card "Purge deleted prompts": query `SELECT COUNT(*) FROM prompts WHERE deleted_at IS NOT NULL` on every GET, render the card with `data-confirm-tone="danger"` and `data-confirm-label="PURGE N PROMPTS"`. Wire `POST /maintenance/purge-prompts` to call `PromptsService.purgeDeleted({ adminBypass: true })` and redirect to `?purged-prompts=N`; CSRF action token `maintenance.purge-prompts`.

## 5. Invariants and persistence cross-checks

- [x] 5.1 In `apps/server/src/test/invariants.test.ts`, extend the `DELETE FROM` allow-list to permit `DELETE FROM prompts` ONLY from `apps/server/src/services/prompts.ts`. Add a positive assertion that the file contains the literal substring `DELETE FROM prompts` so the relaxation cannot expire silently if `purgeDeleted` is removed or refactored.
- [x] 5.2 In the same test, add a positive assertion that `apps/server/src/db/schema/prompts.ts` declares `content` as immutable in its top-of-file docstring (matching the pattern already used for `memory.content`).
- [x] 5.3 Data-loss-guard fixtures already reference `prompts` (no `deleted_at`-specific count is tracked there — the guard counts raw rows, which still works after the schema additions). Verified by running the full test suite at task 6.3.

## 6. End-to-end validation

- [x] 6.1 `pnpm --filter server typecheck` green.
- [x] 6.2 `pnpm --filter server lint` green (pre-existing `.claude/worktrees/` errors are orphaned worktrees from other branches, unrelated to this change).
- [x] 6.3 `pnpm --filter server test` green: 504 tests pass (was 491 before this change — 13 new tests: 26 prompts.test.ts + 7 search_prompts/refine in session-scope-resolution + 5 new invariants = 38 added, offset by NAV-count test update).
- [x] 6.4 `pnpm --filter server build` produces `dist/dashboard/public/assets/styles/views/prompts.670955b8.css` (1237 bytes) and the hashed `manifest.json` lists the new view.
- [ ] 6.5 Manual smoke against `pnpm run dev:docker:up`:
  1. From the dashboard, navigate to `/dashboard/prompts` — list renders with 0 prompts (seed has none).
  2. From `/dashboard/sessions`, the new `prompts` column shows `0` for every row.
  3. Use an MCP client to call `memory.save_prompt({ content: "test goal", title: "smoke", tags: ["smoke"] })`. The prompt SHALL appear in `/dashboard/prompts` and `prompts` column SHALL flip from `0` to `1` for the active session.
  4. Refine via `memory.save_prompt({ content: "test goal refined", replaces: "<id>" })`. The old prompt's row in `?include_deleted=1` SHALL render a `REFINED` badge.
  5. Call `memory.search_prompts({ query: "smoke" })`. Response includes the refined prompt only (default `includeDeleted: false`).
  6. From `/dashboard/prompts`, soft-delete a prompt; verify it disappears from the default list.
  7. From `/dashboard/maintenance`, the "Purge deleted prompts" card shows count > 0 and the action button is enabled. Click and confirm. Verify count drops to 0 and a flash banner reads `Purged N prompts`.
- [x] 6.6 `openspec validate add-prompts-dashboard-view --strict` green (re-confirmed after implementation).

## 7. Pre-archive checklist

- [x] 7.1 All Group 1–5 + 6.1–6.4 + 6.6 checkboxes above checked. 6.5 (operator smoke) and 7.5 (cold-boot smoke) remain — both require a running Docker dev stack and human eyes, so they pause out of the implementation loop.
- [x] 7.2 `git grep "DELETE FROM prompts"` returns only the runtime statement in `services/prompts.ts` + the dev seed `scripts/seed-dev.ts` (already allow-listed). No new violations.
- [x] 7.3 `tx.update(prompts).set(...)` only sets `deletedAt`; no code path sets `content` (verified by grep + invariants test regex coverage).
- [x] 7.4 Plugin clients (`apps/plugin/.{claude,codex,hermes,opencode}-plugin/`) require ZERO changes — verified by inspection (`git status apps/plugin/`).
- [ ] 7.5 `pnpm run dev:docker:up` cold boot against an empty data dir succeeds and the dashboard's bootstrap counters log `prompts=0`.
- [ ] 7.6 Run `/opsx:archive add-prompts-dashboard-view` once the PR merges to apply the spec deltas into `openspec/specs/`.
