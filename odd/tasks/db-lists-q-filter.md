# packages/db: server-side `q` filter for relations, entities, agent-sessions

Contract with the parent session's UI work (odd/tasks/dashboard-lists-pagination-search.md):
add an optional `q` (corpus-wide keyword filter) to three admin read paths. SQL stays in
packages/db (data-access confinement). Escape LIKE wildcards. Count queries must apply the
same conditions as the list queries.

## Tasks

- [ ] relations-repository.ts: `AdminRelationFilters.q?: string`. List (`adminListWithContent`)
      already joins sourceMemory/targetMemory — filter LIKE on both titles+contents. The count
      (`adminCountWithFilters`) has NO joins — add the joins when `q` is set so counts match.
- [ ] entities-repository.ts: `q?: string` on adminListEntities + adminCountEntities (LIKE on
      memoryEntities.value; mind the singleReferenceOnly HAVING path so both paths honor q).
- [ ] agent-sessions-repository.ts: `AdminSessionFilters.q?: string` on adminList + its count
      (LIKE on title/description/summary; keep existing joins/filters intact).
- [ ] Co-located tests for each (control case without q must pass too).

## Commits

- (pending)
