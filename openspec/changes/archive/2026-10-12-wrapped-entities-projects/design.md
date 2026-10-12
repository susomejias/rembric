## Context

Wrapped already uses an instance-admin-only aggregate payload and local canvas export. Existing entity identities are scoped, but this recap describes the whole instance.

## Goals / Non-Goals

**Goals:** two anonymous scenes, truthful annual counts, compact entity summary in both exported formats.

**Non-Goals:** entity values, project names, interactive graphs, inferred productivity, new indexes or dependencies.

## Decisions

- Count entities by distinct `(kind, value)` across links to retained memories created in the selected UTC year up to now. Recurrence means at least two distinct included memories. Deduplicate across projects; counting scoped entity rows instead would inflate instance-wide references. Entity creation/scan time does not determine the recap year.
- Viewer type counters count distinct included memories per kind, not entity identities. Multiple identifiers of one kind within a memory count once; a memory can count toward several kinds. Return a separate `memoryKinds` aggregate to avoid relabeling the PNG's existing unique-entity counts. Display every populated kind rather than grouping the tail into Other; dense lists scroll within the story content.
- Report scanned project-linked memories out of eligible project-linked memories in the year. Global memories are not eligible for the current indexer. Scan completion does not guarantee successful extraction. Partial indexing produces an explicit coverage note in viewer and PNG, not a claim of a complete total. A scanned memory with no entities still counts toward coverage. Read-only recap never initiates indexing.
- Keep project activity count unchanged. Separately group included memory saves by non-null project ID, return only the four highest counts plus the remainder. Percentages use project-linked memories, excluding global memories; sessions-only projects remain active but add no card to the memory ranking. Rank labels are local to this recap, never stable aliases.
- Reuse existing bars, counters, palette, seven-second playback and reduced-motion behavior. Present entities like the sessions scene: a lime pass for the kind with the most memories, remaining kinds with memory counters in the shared bar list, with total and recurring counts below. Reuse the memory-category file deck for anonymous project cards, as requested by the user. No data values or names leave the SQL boundary.
- Keep existing export content; add a fourth metric for entities and a compact type strip between the hero and secondary metrics. This is smaller than embedding both new scenes in the PNG.

## Risks / Trade-offs

- [Risk] Historical indexing backfills change entity totals → label counts as indexed references linked to that year's retained memories and disclose incomplete coverage.
- [Risk] Five project cards can exceed short viewports → use compact deck spacing and verify all cards plus the leading share fit on desktop.
- [Trade-off] Scope-wide duplicate identifiers collapse → accepted because the instance recap measures distinct literal references, not ownership or semantic identity.
- [Risk] New aggregates increase request cost → bounded result payload and focused SQLite integration checks; no speculative indexes.

## Migration Plan

No migration. Roll back code to remove the added read-only fields and presentation.

## Open Questions

Visual iteration remains with the user on the local viewer.
