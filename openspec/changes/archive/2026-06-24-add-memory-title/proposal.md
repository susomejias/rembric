## Why

A memory's only human-facing label today is its ULID. The dashboard detail header renders `Rembric Memory <shortId>`, so an operator cannot tell what a memory is about without reading its full `content`; list, predecessor, and judgment views truncate `content` as a stand-in. The MCP read surface has the same gap: `memory.context` / `memory.search` / `memory.timeline` ship a content snippet but no compact label, so an agent must read prose to triage relevance. A first-class, mandatory `title` gives every memory a short, scannable label across both surfaces.

## What Changes

- **BREAKING** `memory.save` gains a **required** `title` argument (`string`, 1–100 chars). Callers that omit it are rejected at the MCP boundary. Agent-facing tool description updated accordingly.
- New **NOT NULL** `memory.title` column with a DB-level `CHECK(length(title) BETWEEN 1 AND 100)` — the database itself forbids empty or over-long titles. Added via a table-rebuild migration (SQLite cannot add a NOT NULL column or a CHECK in place).
- **Backfill**: existing rows get a title derived from their `content` (first line, markdown-stripped, truncated to 100, with a non-empty guarantee) inside the rebuild's `INSERT … SELECT`. No empty titles ever exist.
- A deterministic, LLM-free `deriveTitle(content)` helper (exported) supplies titles for non-curated write paths: `memory.capture_passive` and the dev seed. The service layer requires `title`; these callers pass `deriveTitle(content)` explicitly.
- `title` is **append-only / immutable** like `content`: written only at INSERT, never UPDATEd. Added to the never-UPDATE invariant guard.
- `title` is surfaced everywhere memory content is shown:
  - MCP reads: `memory.search` rows, `memory.get` (memory + head + predecessors), `memory.timeline` neighbors, `memory.context` (recentMemories, pendingJudgments source/target, needsReview), and `memory.save` candidates.
  - Dashboard: detail header (replaces the shortId as the heading; shortId demoted to a meta chip), list, predecessors, and judgments source/target.

## Capabilities

### New Capabilities

<!-- none — this extends existing memory/mcp-api/dashboard contracts -->

### Modified Capabilities

- `memory`: new requirement — every memory MUST carry a non-empty title (≤100 chars), required at save, enforced NOT NULL + CHECK at the DB, immutable, and exposed by every read that returns a memory. Also: `title` participates in hybrid retrieval — the FTS5 index covers `title` (weighted boost on the lexical branch) and the per-memory embedding is computed from `title + content`; the stale-vector re-embed trigger generalizes from "model change" to "model or embedding-input change".
- `mcp-api`: `memory.save` input gains a required `title`; memory-returning read tools (`memory.search`, `memory.get`, `memory.timeline`, `memory.context`) and `memory.save` candidates gain a `title` field.
- `dashboard`: memory detail/list/predecessor and judgment views display `title`; the detail header heading becomes the title.
- `mcp-api`: the `initialize.instructions` protocol-teaching block's save flow names the required `title`.
- `claude-code-plugin`: the `/remember` command passes a `title` (required by `memory.save`).
- `hermes-agent-plugin`: `system_prompt_block()` (byte-identical to `instructions.ts::BASE`) names the required `title` in its save flow.

## Impact

- **Schema / migration**: `apps/server/src/db/schema/memory.ts` (+`title` column, types), new `apps/server/src/db/migrations/00NN_add_memory_title.sql` (table-rebuild: create `memory_new` with `title TEXT NOT NULL CHECK(...)`, `INSERT … SELECT` backfill, drop/rename, recreate indexes + FTS/vec triggers). Touches the append-only invariant — covered by this OpenSpec change.
- **Service**: `apps/server/src/services/memory.ts` (`SaveMemoryInput.title: string`, threaded into the insert), new `deriveTitle` helper (location: `services/memory.ts` or a small `db/`/`services/` util).
- **Repository**: `apps/server/src/db/repositories/memory-repository.ts` (insert values include `title`; dashboard relations join projection adds `sourceTitle`/`targetTitle`; candidate projection adds `title`). Reads that hydrate full rows get `title` for free via `$inferSelect`.
- **MCP**: `apps/server/src/mcp/memory-tools.ts` (save schema `title` required; `memoryRow`, `memoryGetOutput`, `memoryNeighbor`, `contextOutput.{recentMemories,pendingJudgments,needsReview}`, `candidate` gain `title`; handlers populate it), `apps/server/src/mcp/observability-tools.ts` (`capture_passive` derives title), `apps/server/src/mcp/_shared.ts` (`serializeMemory` adds title). `memory.suggest_topic_key` already accepts an optional `title` input — no change, only agent guidance to pass it.
- **Dashboard**: `apps/server/src/dashboard/memories.ts` (header, list, predecessors), `apps/server/src/dashboard/judgments.ts` (source/target).
- **Seed / tests**: `apps/server/src/scripts/seed-dev.ts` (supply titles), `apps/server/src/test/invariants.test.ts` (title in never-UPDATE guard; migration FK-safety already covered), plus co-located tests for save/search/get/context/timeline/dashboard.
- **Search (FTS + embeddings)**: migration `0016` additionally recreates `memory_fts` with a `title` column + title-writing triggers + rebuild; `apps/server/src/db/repositories/memory-repository.ts` (`searchBm25Ids` applies `bm25(memory_fts, …)` title weights); `apps/server/src/embeddings/embedder.ts` (`EMBEDDING_INPUT_VERSION`, `embeddingInput(title, content)` helper); `apps/server/src/embeddings/state.ts` (marker carries `inputVersion`; mismatch wipes + re-embeds); `apps/server/src/services/embedding-worker.ts` (`embedNow` takes title; batch embeds `title+content`; `findMissingEmbeddings` selects `title`); `apps/server/src/server/{bootstrap,server}.ts` + `apps/server/src/mcp/memory-tools.ts` (`embedNow` wiring threads `title`).
- **Agent-facing surfaces that hardcode the save shape**: because `title` is now required, two static surfaces that name `memory.save`'s arguments must teach it: the Claude Code `/remember` command (`apps/plugin/commands/remember.md`) and Hermes' `system_prompt_block()` (`apps/plugin/.hermes-plugin/__init__.py`, kept byte-identical to `instructions.ts::BASE`). The proactive-save _nudge_ text (server `instructions.ts` BASE + its Hermes mirror) gains the `title` mention. Plugin transport/lifecycle code is otherwise untouched — `memory.save` is an MCP tool the agent calls directly (not an HTTP session endpoint), so the bridge/hooks are unaffected.

## Title participates in search (both retrieval branches)

`title` is not display-only — it feeds BOTH halves of hybrid retrieval, done properly rather than bolted on:

- **Lexical (FTS5)**: `memory_fts` gains a `title` column (the external-content vtable is recreated with `(content, tags, title)`; the `memory_ai`/`memory_ad`/`memory_au` triggers write `title`; the index is rebuilt). The search lexical branch ranks with a title weight boost (`bm25(memory_fts, wContent, wTags, wTitle)` with `wTitle > wContent`) so a query hitting the title surfaces that memory higher.
- **Semantic (vector)**: the embedded text becomes `title + "\n\n" + content` (helper `embeddingInput`) instead of `content` alone, so the curated headline shapes the vector. Existing vectors are **re-embedded** corpus-wide by reusing the established stale-vector mechanism: the embedding identity marker (`embedding-state.json`) gains an `EMBEDDING_INPUT_VERSION`; bumping it makes `ensureVectorModel` wipe `memory_vec` on boot and the background drain re-embed every non-archived row with the new input — resumable, no manual script, no new infrastructure.
- **BREAKING (search ranking)**: search ordering and save-time candidate surfacing change because titles now contribute to both branches; the FTS-side candidate thresholds are unaffected (the candidate detector keeps default BM25 weights).
