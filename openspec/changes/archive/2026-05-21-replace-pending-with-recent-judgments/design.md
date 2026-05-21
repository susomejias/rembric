## Design notes

### Why "judged" and not "judged + orphaned"

`orphaned` relations are candidates the consolidator could not resolve in 96 h. They are signal worth surfacing somewhere, but the home overview is not the right venue: an orphaned row carries no verdict (`relation IS NULL`), so it would render as a verdict-pill-less stub that breaks the visual rhythm of the other rows. Operators already have visibility into orphans via the `ORPHANED PENDINGS` cell of the `CONSOLIDATION HEALTH` strip directly below. Including them in `RECENT JUDGMENTS` would be a category error — they are _failures to judge_, not judgments.

The query is locked to `status = 'judged'`. Orphaned rows are intentionally excluded.

### Why `judged_at DESC`, not `created_at DESC`

`created_at` is when the candidate first surfaced (typically at `memory.save`). `judged_at` is when the verdict was written (by the agent via `memory.judge` / `memory.compare`, by topic-key auto-supersede, or by the consolidator's promotion pass). For a "what just happened" block, `judged_at` is the correct axis — `created_at` would float pending-then-late-judged rows above truly recent verdicts. The existing `memory_relations_status_created_idx` does not cover this sort, but at `LIMIT 4` over a small table it does not matter; if the dataset grows we can add `(status, judged_at)` later.

### Why 4 rows, three lines each

This matches the pending tile's previous density verbatim. The two tiles in `.row-2` need to align vertically with the right-hand `RECENT SESSIONS` tile (5 rows × ~2 lines each ≈ same height). Four three-line rows is the existing visual budget — no responsive churn.

### Why drop the JUDGE button

The button only made sense on pending rows (the action it offered was "go close this verdict"). On a judged row there is nothing left to do; the entire row is a record of past action. Removing the button collapses the `.acts` column and lets the snippets breathe.

### Why the `OPEN ALL ›` link drops the `?status=pending` filter

If the inline block now shows judged rows, linking the section header to a pending-filtered view would be misleading — operators expect "OPEN ALL ›" to expand the _same_ dataset, not jump to a different filter. The default `/dashboard/judgments` view shows all statuses with judged rows on top by recency, which matches the block's content. The `PENDING JUDGMENTS` stat card stays as the explicit shortcut to the backlog.

### Why no schema change

Everything the block needs is already in `memory_relations`: `relation`, `judged_at`, `marked_by_kind`, plus the existing JOIN to `memory.content` on both source and target. No migrations, no FTS edits, no service changes — this is a single SQL query swap + a presentation tweak.

### Coexistence with `add-prompts-dashboard-view`

That change touches the `dashboard` spec by **adding** the `/dashboard/prompts` requirement and **modifying** the `Sessions list` requirement to surface a prompts column. This change **modifies** the `Sidebar links to the new URL` scenario inside the `/dashboard/judgments` requirement and **adds** a new home-overview requirement. The deltas land in different `### Requirement:` sections of the same spec file, so OpenSpec strict validation will merge them cleanly regardless of merge order.
