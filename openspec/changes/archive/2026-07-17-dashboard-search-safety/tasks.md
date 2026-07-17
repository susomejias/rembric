## 1. Stored XSS fix (#252)

- [x] 1.1 `apps/server/src/dashboard/sessions.ts`: escape the prompt-tags `raw()` interpolation (session detail prompts section).
- [x] 1.2 `apps/server/src/dashboard/sessions.ts`: escape the `projectSlug` `raw()` interpolation (sessions list).
- [x] 1.3 Add a regression test hitting the real router: a malicious prompt tag on the session-detail page renders escaped, not as live markup; a legacy (regex-violating) project slug on the sessions-list page renders escaped, not as live markup.

## 2. FTS5 raw-query crash fix (#258)

- [x] 2.1 `apps/server/src/services/prompts.ts`: sanitize `input.query` via `sanitizeFtsQuery` in `searchByScope` before calling the repository; empty-after-sanitize falls back to the recency path.
- [x] 2.2 `apps/server/src/dashboard/prompts.ts`: split `rawQuery` (redisplayed) from `query` (sanitized, used for `MATCH` + branch selection).
- [x] 2.3 `apps/server/src/dashboard/memories.ts`: same split.
- [x] 2.4 Add a regression test for `PromptsService.searchByScope`: a query with FTS5 metacharacters (apostrophe, question mark) returns the expected match instead of throwing; a query that sanitizes to nothing falls back to recency.
- [x] 2.5 Add a regression test hitting the real dashboard routers: the memories and prompts search boxes don't 500 on punctuation, still find the expected match, and redisplay the operator's original (unsanitized) input.

## 3. Validation

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 `pnpm test` full suite green.
- [x] 3.3 `openspec validate dashboard-search-safety --strict` passes.
- [x] 3.4 Update issues #252, #258 with the outcome after merge.
