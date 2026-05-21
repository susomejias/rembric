## Context

Prompts have lived as a write-side feature since the `add-sessions-and-research-tools` change (2026-05-14, migration `0004_prompts.sql`). They serve a single read path today — `memory.context.recentPrompts`, returning the latest N (≤50) rows ordered by `created_at DESC` for the active scope. There is no MCP search, no by-id retrieval, no dashboard view, and no lifecycle column. The data accumulates and becomes operationally invisible — both to the operator (who cannot inspect or clean it) and to the agent (who can only see whatever fits in the 50-row recency window).

This change brings prompts up to peer-resource parity with memories on three axes: **operator surface** (`/dashboard/prompts` list, soft-delete, maintenance purge, session-detail integration), **agent retrieval surface** (`memory.search_prompts` with FTS5), and **structured metadata** (`title`, `tags`) so retrieval is efficient and lists are scannable. It also introduces a minimal supersede mechanism (`replaces` link in `memory.save_prompt`) that lets an agent atomically refine a stale prompt — without bringing the full `topic_key` + `status` machinery from memories.

Append-only is preserved: prompts.content is never UPDATEd, the only lifecycle column is `deleted_at` (operator) — refines and operator-deletes share the same column, distinguished by whether `replaces` is set.

## Goals / Non-Goals

**Goals**

- Operator-visible prompts: list, filter, search, soft-delete, undelete, purge.
- Agent-retrievable prompts: FTS5-backed `memory.search_prompts` with structured filters.
- Atomic refine: `memory.save_prompt({ ..., replaces: <id> })` supersedes a stale predecessor in one MCP call.
- Structured metadata for efficient retrieval: optional `title` + `tags`.
- Visual parity with the existing sessions UX: same row-action patterns (Delete/Undelete + `data-confirm` modal), same `?include_deleted=1` toggle, same maintenance-purge card pattern.
- Zero plugin-client churn: all schema/MCP additions are backward-compatible.

**Non-Goals**

- A detail page at `/dashboard/prompts/:id` (deferred — V1 ships list + inline expand-on-click only).
- `memory.get_prompt` MCP tool (deferred — `memory.search_prompts` with an `id` query covers the fetch use case for now).
- `topic_key` / `status` enum on prompts (explicitly rejected — see Decision 4).
- Renaming `memory.save_prompt` → `prompts.save` namespace (deferred to a dedicated proposal).
- Passive prompt capture (`/prompts/passive` HTTP endpoint) — out of scope for this change; tracked elsewhere.
- Mentioning `memory.search_prompts` in the 800-char `initialize.instructions` crib sheet (the cap is tight; `tools/list` remains the discovery mechanism).
- Adding embeddings to prompts (FTS5-only retrieval V1).

## Decisions

### Decision 1: Refine semantics use `replaces` + soft-delete-old, NOT a new `replaced_at` column

When the agent calls `memory.save_prompt({ content, replaces: <oldId> })`, the server runs an atomic tx that flips `deleted_at = now()` on the old row and inserts the new row with `replaces=[oldId]`. The dashboard list distinguishes operator-deletes from agent-refines by inspecting `replaces`: a row with `replaces != NULL AND deleted_at != NULL` is rendered with a `REFINED` badge in the `?include_deleted=1` view; everything else with just `deleted_at != NULL` is `DELETED`.

**Alternatives considered:**

- **A separate `replaced_at` column** with two toggles in the dashboard (`?include_deleted` + `?include_replaced`). Rejected: doubles the toggle surface, doubles the read-filter clauses across the entire codebase, and the operator-distinguishable semantics can be derived from `replaces` without a second timestamp column.
- **Full `status` enum (`active` | `superseded`)** mirroring `memory.status`. Rejected as Decision 4 below — the volume and use-case profile of prompts don't justify the dual-dimension lifecycle complexity.
- **Just link, no auto-delete** — passing `replaces` would only set the chain and the operator/agent would still need a second action to hide the old. Rejected: the natural UX of "refine" is destructive on the old; making it two steps undermines the whole point of supplying the predecessor id in one call.

### Decision 2: FTS5 over `content + tags`, mirroring the `memory_fts` pattern exactly

A new `prompts_fts` virtual table (contentless, `content_rowid='rowid'`) indexes `prompts.content` and a flattened `tags` string (via `group_concat` over `json_each`). Three triggers: `AI` (insert), `AU` (update — needed because soft-delete and replaces are UPDATEs even though content itself is immutable), `AD` (delete — defensive, since `purgeDeleted` is the only DELETE path). The index keeps ALL rows including deleted/replaced; read queries filter on the outer `prompts` table.

**Alternatives considered:**

- **Skip FTS5, use SQL `LIKE`** scanning over `prompts.content`. Rejected: the agent retrieval surface (`memory.search_prompts`) needs reliable substring + token-aware matching, and the existing FTS5 setup pattern is well-understood. Marginal cost of one more virtual table is low.
- **Add embeddings + sqlite-vec mirror** like memories have. Rejected V1: prompts are short curated saves; FTS5 alone is sufficient and the embedding worker would need re-architecting to handle a second source table.

### Decision 3: Sessions list gains a `prompts` column (B-1), NOT a combined `mem/prompts` cell (B-2)

The existing sessions table query already issues a subselect for memory counts grouped by `session_id`. Add a parallel subselect for prompts (`SELECT session_id, COUNT(*) AS n FROM prompts WHERE session_id IS NOT NULL AND deleted_at IS NULL GROUP BY session_id`) and render the result as a new column right of `memories`.

**Alternatives considered:**

- **Combined `mem / prompts` cell** (`12 / 5`). Rejected: brutalist tables are alignment-driven; a slash-formatted compound cell breaks right-alignment of numeric columns and reads worse at a glance.
- **No column, prompts only on detail page.** Rejected: the operator cares about prompt density per session — denying that signal in the list view forces a click-per-row to compare.

### Decision 4: `topic_key` and `status` enum on prompts are deferred indefinitely

Prompts are positioned as **curated, reusable, mostly-static directives** (per the docstring fix in this change), not as evolving truth-of-the-moment knowledge. The convergent-update problem `topic_key` solves on memories does not have a documented analogue on prompts today. The lighter-weight `replaces` mechanism (Decision 1) covers the rare case of in-place refinement without introducing a second lifecycle dimension.

**Alternatives considered:**

- **E-full: add `topic_key text`, `status text CHECK (active|superseded)`, partial unique index, `saveWithTopicKey` service method.** Rejected for V1 — the additional ~50-60% implementation cost is unjustified by the empirical use case (no production data shows the goal-evolves-over-time pattern). If observed later, the columns are nullable additions and the migration is straightforward.
- **Use `topic_key` semantics on memories for the goal-evolves case + keep prompts as static.** Accepted as the design intent: when the user's _goal_ evolves, the agent should save THAT as a memory with `topic_key`. Prompts remain reusable inputs.

### Decision 5: New MCP tool is `memory.search_prompts`, NOT `prompts.search`

The new tool lives under the existing `memory.*` namespace to avoid a breaking rename of `memory.save_prompt` and to keep this proposal scoped. A separate proposal can later rename both into a `prompts.*` namespace (with deprecation aliases) once the per-resource conventions stabilise.

**Alternatives considered:**

- **`prompts.search` + rename `memory.save_prompt` → `prompts.save` with deprecation alias.** Rejected for this change: introduces a breaking-name surface across all four plugin clients (even with aliases, plugin tests would need to be updated). Better as a dedicated cleanup proposal.
- **Extend `memory.search` with a `kind: 'memory' | 'prompt'` discriminator.** Rejected: the input schemas, filter semantics, and return shapes diverge enough that a single tool would be lossy or balloon in complexity.

### Decision 6: Session detail layout is A2 (memories above prompts), confirmed after a peer-resource reframing

Initial layout debate considered prompts-first (causal narrative: ask → learnings) vs memories-first. After clarifying that prompts are **curated saves with retrieval value**, not low-signal context, the design intent stabilised on memories-first because:

- The operator opens a session detail to see what was _learned_ — memories are the highest-signal artifact.
- Prompts are the _inputs_ that drove the session; conceptually upstream but operationally secondary.
- The headers (`<h2>Memories (N)</h2>`, `<h2>Prompts (N)</h2>`) share identical CSS weight; ordering is the only signal of priority, and brutalist tables expect this.

**Alternatives considered:**

- **A1 (prompts above memories)** — better narrative ordering. Rejected: optimises for storytelling, not for the operator's primary lookup mode (which is "what was concluded in this session?").
- **C (interleaved chronological timeline)** — mix prompts + memories sorted by `created_at`. Rejected: mixing two row shapes in one table breaks brutalist alignment and offers little operational value over two stacked tables.

### Decision 7: Empty-session purge predicate is relaxed (C-relaxed)

The existing maintenance purge for empty sessions today requires `NOT EXISTS (SELECT 1 FROM prompts WHERE session_id = sessions.id)`. With this change, the predicate is updated to `NOT EXISTS (SELECT 1 FROM prompts WHERE session_id = sessions.id AND deleted_at IS NULL)`. Soft-deleted prompts no longer block a session from being purgeable.

**Alternatives considered:**

- **Strict (no change)** — soft-deleted prompts still block. Rejected: forces a two-step workflow (purge prompts → then purge session) that breaks the operator's intent flow ("this session has no live data; clean it up").

### Decision 8: Maintenance gains a third purge card "Purge deleted prompts" (D-yes)

The maintenance page already hosts two danger-toned purge cards (`Purge empty sessions`, `Purge disconnected archived memories`). A third card follows the same pattern with action token `maintenance.purge-prompts`, count = `COUNT(*) FROM prompts WHERE deleted_at IS NOT NULL`, and `purgeDeleted({ adminBypass: true })` as the service call. Writes one `consolidation_ops` row with `op_type='prompt_purge'` per purge invocation.

**Alternatives considered:**

- **No physical purge** — leave soft-deletes accumulating. Rejected: same rationale as the existing two purge cards (operator needs the hand to control DB growth without leaking implementation details).

## Risks / Trade-offs

- **[Risk] The `replaces` atomic tx race** — two agents (rare in practice; rate-limit blocks most cases) calling `memory.save_prompt` with the same `replaces=<id>` simultaneously could both succeed, producing two new rows pointing at the same predecessor while the predecessor is soft-deleted once. → **Mitigation**: the tx checks `deleted_at IS NULL` on the predecessor under SQLite's write lock; the second tx fails with `prompt_already_deleted` after the first commits. Tested explicitly.
- **[Risk] `prompts_fts` index drift on bulk operations** — if a future maintenance op bypasses triggers (e.g., raw INSERT for backfill), the index goes stale. → **Mitigation**: the existing pattern already documents this risk for `memory_fts`. The `AI`/`AU`/`AD` triggers cover all expected code paths. A future `pnpm` script to rebuild from scratch via `INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild')` can be added if drift is observed.
- **[Trade-off] No `replaced_at` column means operator-delete and agent-refine share the same column** → Accepted because the `replaces` link encodes the "why" and the dashboard renders distinct badges. Saves a column, a toggle, and a filter clause across all reads.
- **[Trade-off] `memory.search_prompts` is `memory.*` namespaced** → Accepted to keep this change scoped; a future `rename-prompts-namespace` proposal can clean up consistently.
- **[Trade-off] No detail page V1** → Accepted because the cost (new route, new CSS file, new partial templates) does not match V1 value. Inline `<details>` expansion on the list row covers the "see full content" case. If operators report needing chain visualisation, a follow-up adds the detail page.
- **[Risk] FTS5 trigger fires on every UPDATE (soft-delete, undelete, refine)** — small overhead, but the AU trigger re-deletes + re-inserts the row in the index. → **Mitigation**: identical to `memory_fts` AU pattern. Volume of prompts is low (curated saves, not passive capture in V1), so the overhead is negligible.
- **[Risk] Append-only test surface drift** — adding `purgeDeleted` to the allow-list could mask future violations if not asserted positively. → **Mitigation**: the invariants test additions assert BOTH the allow-list entry AND the positive presence of `DELETE FROM prompts` in `services/prompts.ts::purgeDeleted` (matching the existing pattern for memory + sessions purges). The relaxation cannot expire silently.
