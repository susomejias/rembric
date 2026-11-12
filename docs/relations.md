# Memory relations

The `memory_relations` table records the judgment graph between memories. Each row is one of:

- **candidate** — detected at `memory.save` time in the middle or high confidence band, awaiting agent judgment (`status='pending'`, `relation=null`). A low-band pair is returned in the save response's `related[]` and never gets a row (see `docs/embeddings.md`).
- **judged verdict** — from the agent (`memory.judge_batch` / `memory.compare`) (`status='judged'`, `relation` set, `marked_by_kind` set).
- **orphan** — closed without a verdict (`status='orphaned'`, `relation=null`): one of its memories was retired, which closes the pair in the same transaction; or the deterministic sweep closed it, because no agent judged it before the deadline or its stale pending drain found that no current save-time channel would surface the pair.

## Lifecycle

```
   memory.save          memory.judge_batch       retirement, or the
   surfaces a            closes the            sweep's deadline
   candidate             pending row           or stale drain
        │                     │                       │
        ▼                     ▼                       ▼
    pending ─────────────▶ judged ─────────▶ (terminal)
        │
        ▼
    orphaned ────────────▶ (terminal, except a late verdict after a retirement orphaning: back to judged)
```

A row stays `pending` until an agent closes it via `memory.judge_batch({ judgments: [{ judgmentId, relation }] })`. After `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) it re-surfaces in `memory.context.pendingJudgments[]` so any later session can judge it with fresh context, while BOTH endpoints are still `active`. After `JUDGMENT_ORPHAN_DEADLINE_MS` (default 14 days) the deterministic sweep marks it `orphaned` (journaled, undoable). `memory.compare` writes `status='judged'` directly with no preceding pending phase.

A verdict sent for a row that a retirement orphaned (a live `orphan_promote` op with the `endpoint retired at retirement` prefix) is accepted and moves it to `judged`, so a `judge_batch` that supersedes S→T and then judges T→U still succeeds. A row orphaned by the deadline or a drain is refused with `conflict`, and so is a `supersedes` verdict while either endpoint is not `active`. Undoing the retirement keeps such a late verdict.

### Closed when a memory is retired

Retiring a memory closes its pending pairs in the same transaction, on either side and whatever the other memory's status, because no agent can judge a pair once one of its memories is gone. That holds on every retirement path:

- a `topic_key` revision, for the superseded row;
- a `supersedes` verdict through `memory.judge_batch` or `memory.compare`, for the target;
- a `memory.merge` commit, for every original;
- `memory.archive` and the archive actions in `/dashboard/memories`;
- the sweep's decay pass;
- undoing a merge, for the successor it archives.

Each closed pair is journaled as an `orphan_promote` op with the reasoning prefix `endpoint retired at retirement`. A retirement that already journals an op (`merge`, `agent_memory_archive`, `decay`) journals the closed pairs in that op's run. A `topic_key` revision, a `supersedes` verdict or a merge undo opens one `maintenance` run of kind `retirement_orphan`, only when it has a pair to close. If the journal write fails, the retirement fails with it.

Undoing a decay, an archive or a merge from `/dashboard/consolidation` also restores the pairs that retirement closed. A pair keeps a verdict written after it was closed, and the dashboard says so. A pair stays closed when one of its memories is still retired after the undo, because its topic slot is now taken or the other memory was retired since; its op stays active, and the dashboard names it. Each closed pair can also be restored on its own by undoing its op.

A pending pair with a retired memory therefore exists only when it predates this behaviour, or when an operator restored it by undoing its op. The queue withholds it, `/dashboard/judgments` still lists it, and the stale pending drain below closes it, or the deadline does if an operator restored it.

### Stale pending drain

Each sweep run also re-checks pending pairs against the save-time detection rules of the running build, in the pair's own project, and orphans a pair when:

- **no current channel would create it:** the lexical overlap of the source's content with the target is below `LEXICAL_CANDIDATE_FLOOR` (0.6), the cosine similarity of their stored embeddings is below `VEC_THRESHOLD` (0.7), and the two share no entity, counting each one's stored links and a fresh extraction of its text. The entity check ignores the rarity gate save-time detection applies, so any shared identifier keeps the pair. Age never decides; that stays the deadline's job.
- **or an endpoint is retired:** the source or target was superseded or archived. No agent can judge such a pair, because the queue withholds it. Retirement already closes these pairs, so the drain finds only rows that predate that behaviour.

It never loads the embedding model. A pair stays `pending` whenever a channel cannot be evaluated: a missing vector, a vector index that predates the current embedding recipe, an extraction that fails, an endpoint longer than `DRAIN_MAX_PAIR_CHARS` (64 000 characters), or an unreadable row. Rules drains and retired-endpoint drains journal as `orphan_promote` with their own reasoning prefixes (`stale under current rules`, `endpoint retired`), distinct from the deadline's `unjudged after …`.

The drain works in bounded batches: at most `DRAIN_ROW_CAP` pairs per project per run, within a wall-clock budget that one sweep call shares across its projects, resuming from a cursor kept in the run summary. Each drain commits on its own. Undoing a drain op from `/dashboard/consolidation` restores the pair to `pending`, and the drain never orphans that pair again; the deadline still can. If a verdict was written after the op, for example a `memory.compare` `supersedes`, the undo keeps that verdict and the dashboard says so.

## Taxonomy

| Relation         | Side effect on `memory` rows                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `supersedes`     | target → `status='superseded'`; source's `replaces[]` gains the target id |
| `conflicts_with` | none — both stay active                                                   |
| `related`        | none                                                                      |
| `compatible`     | none                                                                      |
| `scoped`         | none — both valid in different sub-contexts                               |
| `not_conflict`   | none — acknowledged false positive; hidden from search                    |

Only `supersedes` mutates `memory` row status. `memory.compare` rejects `relation='not_conflict'` (only makes sense as a save-time false-positive close).

## Search annotations

Every `memory.search` / `memory.get_batch` result carries a `relations` array:

```ts
{ kind: 'supersedes' | 'superseded_by',          targetId, reason?, confidence?, status: 'judged' }
{ kind: 'conflicts_with' | 'related' | 'compatible' | 'scoped', targetId, ..., status: 'judged' }
{ kind: 'pending_conflict',                      targetId, judgmentId, status: 'pending' }
```

- `supersedes` / `superseded_by` are POV variants of the same row.
- `pending_conflict` rows include the `judgmentId` so the agent can call `memory.judge_batch` directly from search results.
- `not_conflict` and `orphaned` annotations are hidden from search (admin-only on the dashboard).

Annotations default to 10 per memory; `memory.get_batch({ ids: [id], relations_limit: 50 })` requests the maximum 50 with complete reasons. Multi-row reads bound reasons and share the existing 4000-annotation response budget. Batch pages contain at most 20 outcomes. One JOIN keyed on both source_id and target_id — no N+1.

Confirm with explicit `ids: [id, ...]`; judge with `judgments: [{ judgmentId, relation, ... }, ...]`, each with 1–20 submitted items. Confirmations are atomic; judgments retain order and duplicates, each in its own transaction. Inspect every judgment result: mixed success preserves successful mutations; all-failed batches set MCP `isError: true`. Neither mutation selects by dates.

## When to call which tool

| Situation                                            | Call                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save a memory that evolves a known topic             | `memory.save({topic_key})`                                                                                                                                                        |
| Don't know the canonical topic_key                   | `memory.suggest_topic_key` first, then save                                                                                                                                       |
| Save returned `candidates[]`                         | `memory.judge_batch({ judgments: [{ judgmentId, relation }] })`                                                                                                                   |
| Save returned `convergeWith[]` (advisory)            | Map each `judgmentId` to its `candidates[]` entry; `memory.merge` the pair, or judge it `supersedes` and reuse its `topic_key` — or judge it `related` if it is not the same fact |
| Save returned `related[]`                            | Nothing to judge; read them for context, or record a verdict with `memory.compare`                                                                                                |
| Two arbitrary memories analyzed independently        | `memory.compare({memoryIdA, memoryIdB, …})`                                                                                                                                       |
| Search results have `pending_conflict` annotations   | `memory.judge_batch` using the embedded `judgmentId`                                                                                                                              |
| `memory.context` returned `pendingJudgments[]`       | `memory.judge_batch` each entry's `judgmentId`                                                                                                                                    |
| A row's `reviewState` is `needs_review` (still true) | `memory.confirm_batch` — records a confirmation, advancing the affirmation baseline                                                                                               |
| A `needs_review` memory has changed                  | `memory.save({topic_key})` — supersedes the prior row                                                                                                                             |
| `memory.context` returned `needsReview[]`            | resolve each: `memory.confirm_batch` / `memory.save({topic_key})` / `memory.judge_batch` if it conflicts                                                                          |
| Several memories each hold part of one fact          | `memory.merge({ids, …})` to preview, show the user, then the same call with `fingerprint` to commit                                                                               |

> `needsReview` is a **separate axis** from the judgment graph above. The relations here are **pairwise** (conflicts between two memories, closed by `memory.judge_batch`). `needsReview` is **unary** time-based staleness — a single memory whose shelf life elapsed without re-affirmation — and it is **derived at read time** from `max(created_at, last confirmation) + per-type TTL`; it is never stored and never runs a sweep. It only overlaps the judgment graph when a stale memory turns out to contradict another, at which point the normal `memory.judge_batch` flow takes over.
