# Prompts page: design parity with the other list views

Owner (2026-09-28): the prompts list page drifted from the conventions of memories/sessions/etc.
Bring it to parity, applying the SAME decisions as odd/tasks/dashboard-lists-pagination-search.md:

## Tasks

- [ ] Remove the summary line under the h1 (`${total} MATCHING · ${rows.length} rows · …`).
- [ ] Remove the divergent StatCard block ("IN WINDOW") if it duplicates what ServerPager/chips show.
- [ ] Pagination: remove `pageSize={10}` from PromptsTable usage (kills the DataTable internal
      pager); keep ServerPager as the only paginator.
- [ ] Search: wire the existing `?q=` server-side FTS (`repos.prompts.adminSearchFts`) through a
      `q` filter in readPromptsFilters + page; use
      `@/components/dashboard/table-search` (created by the parent session) for the input. Add
      `adminCountFts` to `packages/db/src/repositories/prompts-repository.ts` (SQL stays in
      packages/db; mirror adminSearchFts' FTS5 join; count must match the list set).
- [ ] Table/toolbar structure matches memories page conventions (Page, PageHelp, chips if useful).
- [ ] Verify: pnpm typecheck + focused vitest.

## Commits

- (pending)
