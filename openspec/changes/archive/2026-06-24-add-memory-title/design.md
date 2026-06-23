## Context

A memory's only label today is its ULID. The dashboard detail header renders `Rembric Memory <shortId>` (`apps/server/src/dashboard/memories.ts:355`); list, predecessor, and judgment views fall back to truncating `content`. The MCP read surface ships a `content` snippet but no compact label. There is no `title` column on `memory` (`apps/server/src/db/schema/memory.ts`).

The operator decisions for this change (captured in explore):

- `title` is **required** at `memory.save` (not derived-on-read, not optional).
- Length cap **100** (matches sessions' `TITLE_MAX_LENGTH`).
- The **database** must forbid empty titles → `NOT NULL` + `CHECK`.
- Existing rows are **backfilled** by truncating `content` so no empty titles exist.
- `title` is shown **everywhere** a memory's content appears (MCP + dashboard).
- The MCP save/read tools are modified accordingly.

Memories are append-only: `content` is never UPDATEd, every `save` is a new row, and `topic_key` convergence supersedes by creating a _new_ head row. So a title fixed at insert can never drift from the content it labels — the immutability the operator relied on holds by construction.

## Goals / Non-Goals

**Goals:**

- Every memory carries a non-empty, ≤100-char title, guaranteed by the database.
- `title` is a first-class, required input to `memory.save` and a field on every memory-returning read (MCP + dashboard).
- Backfill all existing rows with a derived title during migration — zero empty titles, zero post-deploy fixup.
- Keep the change server-only (no plugin/wire impact) and LLM-free.

**Non-Goals:**

- No read-time derivation as the primary mechanism (rejected — the column is authoritative, not a cache).
- No editing/curation UI for titles in the dashboard (titles are immutable, like content).
- No replacement of the `content` snippet by `title` in `memory.context` payloads yet — title is added _alongside_ the snippet; trimming the snippet is a separate, measure-first change.
- No new LLM dependency for titling (consolidation/sweep stay deterministic).

## Decisions

### Decision 1: `title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100)` via a table-rebuild migration

SQLite cannot add a `NOT NULL` column without a default to a populated table, and cannot add a `CHECK` in place. Because the operator requires the DB to forbid empty titles, we use the documented table-rebuild dance (per `CLAUDE.md` → "Table-rebuild migrations"): `CREATE TABLE memory_new (… title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100) …)` → `INSERT INTO memory_new SELECT …, <derived title>, … FROM memory` → `DROP TABLE memory` → `ALTER TABLE memory_new RENAME TO memory` → recreate indexes + FTS/vec triggers. The migration runner already wraps every migration in `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` gate → `COMMIT`, so no pragma authoring is needed and FK-safety is asserted before commit.

The `CHECK` covers both the floor (non-empty) and the ceiling (≤100). The service layer validates the same bound for a clean `invalid_input` error before the DB ever sees it.

- _Alternative — `ALTER TABLE ADD COLUMN title TEXT` (nullable) + read-time derivation_: cheapest, no rebuild, but cannot give the DB-level non-empty guarantee the operator asked for. Rejected.
- _Alternative — nullable column + service-only cap_: same gap. Rejected.

### Decision 2: `title` required at the tool boundary; internal callers derive explicitly

`memory.save` requires `title` (`z.string().min(1).max(100)`), and `SaveMemoryInput.title: string` is required at the service layer with no implicit default. Non-curated internal write paths supply a derived title at the call site:

- `memory.capture_passive` (`apps/server/src/mcp/observability-tools.ts`) passes `deriveTitle(content)`.
- `apps/server/src/scripts/seed-dev.ts` passes a literal or `deriveTitle(content)`.

This keeps derivation an explicit, visible decision at the one place it is needed (passive/seed), not a hidden service default that would let an un-titled save slip through silently.

- _Alternative — service derives when title is absent_: convenient but hides the requirement and makes "every curated save has an intentional title" unenforceable. Rejected.
- _Alternative — title optional everywhere_: contradicts the operator's "required" decision. Rejected.

### Decision 3: `deriveTitle(content)` — deterministic, LLM-free

`deriveTitle` takes the first non-empty line of `content`, strips leading Markdown emphasis/heading markers (`**`, `#`, backticks), trims, truncates to 100 chars, and falls back to `content.slice(0, 100)` if the first line is empty. Because `content` is validated non-empty (`min(1)`), the result is always ≥1 char and ≤100 — satisfying the DB `CHECK`. Used by the migration backfill, `capture_passive`, and seed. No model call (consistent with the deterministic consolidation sweep).

### Decision 4: `title` is immutable, added to the never-UPDATE invariant

`title` is written only at INSERT. The `memory` append-only requirement is extended to forbid `UPDATE memory SET title = ?`, and `apps/server/src/test/invariants.test.ts` gains a guard mirroring the existing `content` guard. This makes title-drift structurally impossible and matches the operator's reasoning.

### Decision 5: surface `title` across all read shapes

MCP (`apps/server/src/mcp/memory-tools.ts` zod schemas + handlers):

- `memoryRow` (`memory.search`), `memoryGetOutput.{memory,head,predecessors[]}`, `memoryNeighbor` (`memory.timeline`), `candidate` (save candidates), and `contextOutput.{recentMemories[],pendingJudgments[] (source/target),needsReview[]}`.
- `serializeMemory` (`apps/server/src/mcp/_shared.ts`) adds `title`.
- Reads that hydrate full `$inferSelect` rows get `title` for free; the FTS/vec candidate projection and the dashboard relations join projection are widened to select `title` (and `sourceTitle`/`targetTitle`).

Dashboard:

- `apps/server/src/dashboard/memories.ts`: header heading = `title` (id demoted to a meta chip), list column, predecessor labels.
- `apps/server/src/dashboard/judgments.ts`: source/target labels use `title`.

`memory.suggest_topic_key` already accepts an optional `title` input (`apps/server/src/mcp/topic-key.ts`) and derives the slug from it — no code change, only agent guidance to pass the title it just authored.

### Decision 6: `title` participates in lexical retrieval (FTS5 column + weighted BM25)

`memory_fts` is recreated (inside migration `0016`, after the `memory` rebuild) as `fts5(content, tags, title, content='memory', content_rowid='rowid')`, and the `memory_ai`/`memory_ad`/`memory_au` triggers carry `title` (real `old.title`/`new.title` values; tags keep the existing `''`-on-delete quirk untouched). The interactive search branch (`searchBm25Ids`) orders by `bm25(memory_fts, W_CONTENT, W_TAGS, W_TITLE)` with `W_TITLE > W_CONTENT` (named constants) so a title hit ranks higher. Save-time candidate detection (`searchBm25Candidates`) keeps default `rank` ordering so its calibrated `FTS_THRESHOLD` is undisturbed — only its MATCH now also spans titles (more recall, which is the desired effect for surfacing judgable candidates).

- _Folded into 0016_ rather than a separate `0017`: 0016 already drops the table, recreates the FTS triggers, and rebuilds — creating the triggers in 0016 only to replace them in a 0017 would be wasteful and confusing; "add title (stored + indexed)" is one coherent unit while the change is unmerged.
- _Alternative — leave FTS unweighted_: simpler, but a title match is a strong relevance signal that default weights bury under long bodies. The weight is the cheap part; the column is the load-bearing change.

### Decision 7: `title` participates in dense retrieval (embed `title + content`, re-embed via input-version bump)

The embedded text becomes `embeddingInput(title, content) = title + "\n\n" + content` (one exported pure helper, used at save time and in the drain). To re-embed the existing corpus we reuse the established stale-vector mechanism rather than inventing a backfill: `embedding-state.json` gains an `inputVersion` field, the embedding identity is `(modelId, inputVersion)`, and `ensureVectorModel` wipes `memory_vec` + writes the new marker when EITHER axis differs. Bumping `EMBEDDING_INPUT_VERSION` (to e.g. `v2-title-content`) on this deploy makes every existing install wipe-and-re-embed on boot, in the background, resumable — `memory_vec` is derived data, so wiping it never touches the append-only `memory` table.

- A single combined vector (not a second title vector + fusion) because the title is semantically a subset/lead of the content — one vector captures it; a second index + extra kNN + fusion is unjustified complexity.
- `embedNow` and `findMissingEmbeddings`/`processBatch` thread `title` so both the inline-at-save path and the drain use the same recipe. The `embedNow` dep signature (`memory-tools.ts` `MemoryToolDeps`, `server.ts`, `bootstrap.ts`) gains a `title` parameter.
- _Alternative — manual re-embed script / migration_: rejected; the model-change path already does exactly this, resumably and observably. Generalizing its trigger condition is the principled move and the spec requirement is updated to match.

## Risks / Trade-offs

- [Risk] The table-rebuild migration drops and recreates `memory`, including its FTS5/vec0 triggers and indexes → if a trigger/index is missed, search breaks silently. → Mitigation: enumerate every existing index and trigger on `memory` before writing the migration and recreate them verbatim; the runner's `PRAGMA foreign_key_check` gate plus the existing search/embedding tests catch regressions; run the full suite + a dev:docker:up smoke before landing.
- [Risk] Backfill truncation cuts mid-word or mid-Markdown, producing ugly titles for old rows. → Mitigation: `deriveTitle` strips leading markup and uses the first line, which is already a de-facto lead in practice; accepted as a one-time cosmetic cost on legacy rows (newly saved rows are agent-curated).
- [Risk] A pre-existing row with empty/whitespace-only `content` (the DB only enforces `content NOT NULL`, no non-empty CHECK) would backfill to an empty title and abort the irreversible migration on the new `CHECK(length(title) BETWEEN 1 AND 100)`. → Mitigation: the backfill `coalesce` chain ends in the literal `'untitled'` floor, so every legacy row yields a 1..100-char title regardless of content; covered by a dedicated adversarial-content backfill test in `migrations.test.ts`.
- [Trade-off] **BREAKING** `memory.save` now rejects calls without a `title`. → Accepted because the operator explicitly wants title mandatory; agents read the live MCP schema and adapt, and the tool description is updated to teach it.
- [Trade-off] Title is added alongside the `content` snippet in `memory.context` rather than replacing it. → Accepted because the token win of dropping the snippet is unproven; kept as a follow-up once usage is measured.
- [Risk] Internal callers (`capture_passive`, seed, any future direct `MemoryService.save`) could forget to pass `title` now that it is required. → Mitigation: TypeScript makes `title` a required field on `SaveMemoryInput`, so omission is a compile error, not a runtime surprise.

## Migration Plan

1. Land the schema + migration (rebuild with backfill) behind the normal migration runner; on deploy it runs once, backfilling every existing row. No manual step.
2. Service + repository + MCP + dashboard changes ship in the same PR (the column is NOT NULL from the first migration, so all writers must pass `title` atomically).
3. Rollback: there is no down-migration (the project's runner is forward-only). Rollback = redeploy the prior image against a restored DB snapshot (operator backup per `docs/backup.md`). The rebuild is loss-free for existing columns, so a forward deploy is safe; reverting requires the pre-migration DB file.

## Open Questions

None — the three micro-decisions (DB `CHECK` covers floor+ceiling; `title` added to the never-UPDATE invariant; `title` added alongside the context snippet rather than replacing it) were confirmed with the operator during explore.
