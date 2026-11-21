## Context

A retirement with no consolidation op of its own (a `topic_key` revision, a judged `supersedes`, a merge undo) opens one `consolidation_runs` row with `scope = 'maintenance'` and the summary `{"kind":"retirement_orphan","orphaned":N}` (`orphanPendingOnRetirement` in `packages/core/src/consolidation/operations.ts`). Other writers share the `maintenance` scope with their own `kind`: `session_purge`, `prompt_purge`, `archived_memory_purge`, `agent_memory_archive`, `agent_memory_merge` and `project_archive_orphan`. Those are rare, operator-relevant runs and must stay visible.

## Goals / Non-Goals

**Goals:** keep the first page of `/dashboard/consolidation` for the runs operators inspect; keep retirement runs one click away through a shareable URL.

**Non-Goals:** grouping runs, changing the journal, the run detail, undo, the "latest run" panels or other pages that list runs.

## Decisions

1. **Filter by `kind`, not by scope.** The hidden set is `scope = 'maintenance'` AND the summary's `$.kind` equals `retirement_orphan`. Filtering by scope alone would also hide purge and archive runs. Alternative considered: a new column flagging retirement runs; rejected because the kind is already stored and a column needs a migration.
2. **The SQL stays in the repository.** `adminListRuns(limit, offset, hiddenKind?)` and `adminCountRuns(hiddenKind?)` take the kind to leave out; omitted, they behave as before, so the overview and activity pages are untouched. The kind is guarded with `json_valid`, so a run whose summary is not JSON (for example a malformed legacy row) is never hidden and never makes the query fail. Alternative considered: filtering in the page after the read; rejected because pagination and the total would count rows that are not shown.
3. **The kind is a core constant.** `RETIREMENT_RUN_KIND` is exported next to `PROJECT_ARCHIVE_RUN_KIND`, used by the writer and passed by the page, so the writer and the filter cannot drift. `@rembric/db` cannot import `@rembric/core`, which is why the repository takes the kind as an argument.
4. **State lives in the URL.** `?show-maintenance=1` shows retirement runs; any other value or none hides them. The toggle is a link that drops `page`, because offsets differ between the two lists; the pager carries the parameter. Alternative considered: grouping consecutive retirement runs into one row; rejected because it needs a group-level undo story and a new summary shape.

## Risks / Trade-offs

- [Risk] An operator looking for a retirement run does not find it in the default list → Mitigation: the toggle sits on the list header, and the run detail URL and each op's undo are unchanged.
- [Trade-off] Counting with the filter parses each run's JSON summary → Accepted because `consolidation_runs` grows by runs, not by memories, and the unfiltered count path is unchanged for other pages.
- [Risk] The `drain-stale-save-time-pendings` change also modifies this requirement → Mitigation: whichever change archives second rebases its MODIFIED block onto the published text; `pnpm run check:delta-freshness` reports the stale block.
