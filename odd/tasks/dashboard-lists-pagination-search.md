# Dashboard lists: pagination dedup + corpus-wide search + summary removal

Owner decisions (2026-09-28):

- Pagination: the DataTable internal client pager (footer "1–10 of 50" + arrows) is removed from the
  5 server-paged views (memories, sessions, judgments, entities, prompts). ServerPager stays as the
  ONLY paginator. Tokens/Projects keep client-side pagination (no ServerPager there, no duplication).
- Search: the DataTable `searchable` box is client-side over the loaded page slice only — misleading.
  Owner: search must filter the WHOLE corpus. Wire the existing `?q=` server filters; add `q` support
  to the repos that lack it (relations, entities, agent-sessions; prompts already has adminSearchFts).
- Summary lines under the h1 ("1,791 total · 1,001 active · 68 need review" and equivalents):
  REMOVE in ALL list views (owner decision). Counters-as-filters (status chips) are the count surface.

## Tasks

- [x] Create `apps/web/src/components/dashboard/table-search.tsx` — client component, URL-driven
      `?q=` (router.replace, debounced ~300ms, resets `page`, preserves other params).
- [x] packages/db: add `q` filter to AdminRelationFilters (LIKE over source/target title+content,
      escaped, count query matches list joins), entities adminList/CountEntities (LIKE on value),
      agent-sessions AdminSessionFilters (LIKE on title/description/summary) + co-located tests. (worker db-q-filters)
- [x] memories page: drop `searchable` + `pageSize` props from MemoriesTable usage; render
      TableSearch; remove summary line. (q already server-side via FTS)
- [x] sessions page: same treatment (both tables on the page); remove summary line.
- [x] judgments page: same treatment; remove summary line.
- [x] entities page: same treatment; remove summary line.
- [x] tokens page: remove summary line only (client pagination is legitimate there).
- [x] projects page: remove summary line only.
- [x] prompts page: delegated to worker (see odd/tasks/prompts-page-design-parity.md).
- [x] Verify: pnpm typecheck, focused vitest, grep no `pageSize` on server-paged tables, no duplicate
      pagination rendered. Suite: 60 files / 1121 passed (2026-09-28).

## Commits

- 97b92197 feat(db): corpus-wide q keyword filter (relations, entities, agent-sessions)
- bb94a171 feat(web): one pager, corpus-wide search and server-owned filter pills
- 71734a1a feat(web): prompts list to design parity (lifecycle pills, FTS, adminCountFts)
- 2ba8ee18 fix(web): drop memories-written from session log (worker A)
- 363a43f1 feat(web): volumetric seeder covers tokens and projects (seed worker)
- c8192157 feat(web): projects and tokens onto the shared pills+search pattern
- 65e5eac2 feat(web): memories nav badge counts the whole corpus (owner decision 2026-09-28)
- 62e07724 test(web): projects header subtitle assertion removal

Suite: web 1093 passed / 6 skipped, db 288 passed / 9 skipped, typecheck 7/7, lint clean.

Parallel workers (file-disjoint): session-detail-memories-section, prompts-page-design-parity,
db-lists-q-filter.
