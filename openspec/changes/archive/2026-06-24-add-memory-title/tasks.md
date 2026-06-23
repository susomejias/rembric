## 1. Schema + migration

- [x] 1.1 Add `title: text('title').notNull()` to the `memory` table in `apps/server/src/db/schema/memory.ts` (after `content`); update `Memory`/`NewMemory` are derived automatically. Document the 1–100 CHECK in a comment (Drizzle can't express it).
- [x] 1.2 Write `apps/server/src/db/migrations/0016_add_memory_title.sql` as a table-rebuild: `CREATE TABLE memory_new (… title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100) …)` mirroring the current `memory` columns; backfill via `INSERT INTO memory_new SELECT …, <derived title from content>, … FROM memory`; `DROP TABLE memory`; `ALTER TABLE memory_new RENAME TO memory`.
- [x] 1.3 In the same migration, recreate every index and trigger on `memory`: `memory_scope_project_status_idx`, `memory_status_last_seen_idx`, `memory_created_at_idx`, `memory_session_idx`, the partial `memory_topic_key_active_idx`, and triggers `memory_ai`/`memory_ad`/`memory_au` (FTS5 sync) + `memory_vec_status_sync` (vec) — copied verbatim from migrations 0001/0003/0005/0014.
- [x] 1.4 Backfill title SQL = first line of content, leading `*`/`#`/backtick stripped, truncated to 100, non-empty fallback to `substr(content,1,100)` (implement the strip+truncate in SQL, or precompute is N/A — must be pure SQL inside the migration).
- [x] 1.5 Run `pnpm --filter @rembric/server run migrate` (or boot) against a seeded DB and confirm the migration applies cleanly, `PRAGMA foreign_key_check` passes, and FTS/vec search still returns rows.

## 2. deriveTitle helper

- [x] 2.1 Add exported `deriveTitle(content: string): string` (first non-empty line → strip leading Markdown emphasis/heading markers → trim → truncate 100 → fallback `content.slice(0,100)`), co-located in `apps/server/src/services/memory.ts` (or a small util it owns). Guarantee 1–100 non-empty output.
- [x] 2.2 Unit-test `deriveTitle`: markdown lead, multi-line, over-long, content shorter than 100, edge (first line whitespace-only → fallback).

## 3. Service + repository

- [x] 3.1 Add required `title: string` to `SaveMemoryInput` (`apps/server/src/services/memory.ts`); validate `1 ≤ title.length ≤ 100` (throw `invalid_input` otherwise) in `saveWithTopicKey`; thread `title` into the insert values.
- [x] 3.2 Add `title` to the repository insert path (`apps/server/src/db/repositories/memory-repository.ts` `insertMemory` values).
- [x] 3.3 Widen the dashboard relations join projection to select `sourceTitle`/`targetTitle`, and the FTS/vec candidate projection to include `title`. Full-row reads (`$inferSelect`) get `title` for free — verify the candidate/snippet reads carry it.

## 4. MCP tools (save + reads)

- [x] 4.1 `apps/server/src/mcp/memory-tools.ts`: add required `title: z.string().min(1).max(100)` to the save input schema; pass it into `SaveMemoryInput`.
- [x] 4.2 Add `title` to the output zod schemas: `candidate`, `memoryRow`, `memoryGetOutput.{memory,head,predecessors[]}`, `memoryNeighbor`, `contextOutput.{recentMemories[],needsReview[]}`, and source/target title on `contextOutput.pendingJudgments[]`; populate each in the corresponding handler.
- [x] 4.3 `apps/server/src/mcp/_shared.ts`: add `title` to `serializeMemory`.
- [x] 4.4 `apps/server/src/mcp/observability-tools.ts`: `capture_passive` passes `deriveTitle(content)` to `memory.save`.
- [x] 4.5 Update the agent-facing `memory.save` tool description (and any protocol-teaching `instructions` block) to state `title` is required and what it's for.

## 5. Dashboard

- [x] 5.1 `apps/server/src/dashboard/memories.ts` detail: make the page heading the memory `title`; demote the short id to a metadata chip.
- [x] 5.2 `memories.ts` list + predecessor table: show `title` as the primary label (replace the `truncate(content,…)` link text).
- [x] 5.3 `apps/server/src/dashboard/judgments.ts`: render source/target by `title` (uses the new `sourceTitle`/`targetTitle` projection).

## 6. Seed + invariants + tests

- [x] 6.1 `apps/server/src/scripts/seed-dev.ts`: pass a `title` to every `memorySvc.save(...)` (literal or `deriveTitle(content)`).
- [x] 6.2 `apps/server/src/test/invariants.test.ts`: add a guard forbidding `UPDATE memory SET title = ?` (mirror the existing `content` guard).
- [x] 6.3 Update/extend co-located tests: save rejects missing/empty/over-long title; search/get/timeline/context rows carry `title`; capture_passive derives; dashboard renders title in header/list/judgments.
- [x] 6.4 Fix all existing test call sites of `memory.save` / `MemoryService.save` to pass a `title` (compile error otherwise).

## 8. Title in search — lexical (FTS5)

- [x] 8.1 In migration `0016`, after the `memory` rebuild: `DROP TABLE memory_fts`; recreate as `fts5(content, tags, title, content='memory', content_rowid='rowid')`; recreate `memory_ai`/`memory_ad`/`memory_au` to carry `title` (write `new.title`; delete with `old.title`); the existing `('rebuild')` repopulates content+tags+title.
- [x] 8.2 `memory-repository.ts::searchBm25Ids`: order by `bm25(memory_fts, W_CONTENT, W_TAGS, W_TITLE)` with named weight constants (`W_TITLE > W_CONTENT`). Leave `searchBm25Candidates` on default `rank` (threshold stability).
- [x] 8.3 Test: a memory whose title contains a term absent from content is found via `memory.search` (FTS branch); schema-drift FTS test still green with the new column.

## 9. Title in search — dense (embeddings)

- [x] 9.1 `embeddings/embedder.ts`: add `EMBEDDING_INPUT_VERSION` constant + exported pure `embeddingInput(title, content)` (= `title + "\n\n" + content`).
- [x] 9.2 `embeddings/state.ts`: marker `EmbeddingState` gains `inputVersion`; `ensureVectorModel` mismatches (wipe + re-embed) when model id OR input version differs; write both. Old marker (no inputVersion) → mismatch → re-embed.
- [x] 9.3 `services/embedding-worker.ts`: `embedNow` takes `title`; `processBatch` embeds `embeddingInput(row.title, row.content)`; `findMissingEmbeddings` (`vectors-repository.ts`) selects `title` into `PendingEmbedding`.
- [x] 9.4 Thread `title` through the `embedNow` dep: `MemoryToolDeps` (`memory-tools.ts`) + its call site, the `EmbedNow` type in `server.ts`, and the wiring in `bootstrap.ts`.
- [x] 9.5 Tests: `embeddingInput` shape; `state.test.ts` covers input-version mismatch → wipe+re-embed; embedding-worker embeds title+content.

## 7. Gates

- [x] 7.1 `pnpm run typecheck` + `pnpm run lint` clean.
- [x] 7.2 `pnpm test` green.
- [x] 7.3 `openspec validate add-memory-title --strict` passes.
- [x] 7.4 Smoke against `pnpm run dev:docker:up`: save with title, read it back via search/get/context, view it in the dashboard header. (9/9 checks green incl. title-only-term search hit + dashboard `<h1>` title + id chip.)
