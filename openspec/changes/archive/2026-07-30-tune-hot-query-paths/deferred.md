# Closed without shipping code

Six tasks are ticked in `tasks.md` and shipped no implementation. Each was
closed by a decision, not by being forgotten — but a tick alone reads as "done",
so this is the register. Measurements behind each are in `measurements.md`.

Two categories, and the difference matters to a reviewer: **measured and
declined** (this change did the work, and the work said no) versus **deferred by
operator decision** (settled before implementation started, in `design.md`'s
"Resolved" section).

## Measured and declined

### 4.5 — `scopeActiveMemoryCount` caching or a counter

Re-measured at **0.184 ms per save**, not the 1.09 ms this change's own audit
reported, and it is already computed once per save rather than once per extracted
entity. Both offered fixes cost more than they buy: a per-request cache needs
request context the repository does not have, and a maintained counter is the
same drift hazard that deferred `memory_entities.link_count`. No change.

### 4.6 — `searchBm25Ids` → `rank MATCH 'bm25(...)'`

The task says "ship only if the diff stays small". It is not the diff that
stopped it: **the rewrite is a pessimisation on this corpus.** It does remove the
`USE TEMP B-TREE FOR ORDER BY` exactly as predicted, and the result order is
byte-identical — and it is slower in all three selectivity bands:

| query                 | current   | `rank MATCH` |
| --------------------- | --------- | ------------ |
| narrow (rare term)    | 12.457 ms | 18.613 ms    |
| mid (common term)     | 13.852 ms | 18.556 ms    |
| match-all (4-term OR) | 29.914 ms | 39.792 ms    |

Letting FTS5 order internally costs more than SQLite's temp B-tree over a
400-row rank window. This change predicted 16.8 → 10.9 ms; the ordering of the
two alternatives is reversed here. Not shipped.

### 4.8 — entity fan-out `ORDER BY`

Plan confirmed (temp B-tree over the whole fan-out before the `LIMIT`, so cost is
O(fan-out) not O(limit)) and the alternative measured at **104× with an identical
result set**. Reverted anyway: ordering by the link table's primary key is
equivalent only while every `memory.id` is a ULID whose timestamp prefix equals
its `created_at` — true for every row the application writes, unenforced, and
false for the repository's own test fixture. Taking it would convert a documented
chronological guarantee into a conditional one.

Follow-up **`order-entity-fanout-by-link-pk`**. Its prerequisite is now pinned by
`memory.test.ts::"ULID prefix equals created_at"`, so the follow-up starts with
the invariant asserted rather than assumed.

### 5.1 — the embedding-backlog arithmetic

Measured at 14.6× with an identical result on a harness corpus, and **not taken
in any form**. `memory_vec` is the one derived child of `memory` with no foreign
key, so it can hold rows whose memory is gone, and the shortcut then fails in two
directions: it goes negative (observed on a real dev database at 35 memories
against 4747 vec rows), and — the case a first fix missed — one orphan against
one genuinely pending row **cancels to exactly zero**, reporting a clean backlog
while a row waits. Both are pinned by
`vectors-repository.test.ts::"backlog count survives orphaned vec rows"`.

A gate form (trust only an exact zero, fall through otherwise) was implemented
and then also removed: it inherits the cancelling failure, and independent
measurement showed it was a **regression** in front of `findMissingEmbeddings` —
a 12.7 ms full `memory_vec` scan guarding a 0.039 ms `LIMIT`-bounded query, on
every 30 s tick while a backlog exists, when `EmbeddingWorker.possiblyPending`
already skips that scan at the service layer.

The orphan source was fixed: `seed-dev`'s wipe omitted `memory_vec` while
claiming in a comment that a trigger handled it. Production was never affected —
`purgeByIds` deletes vec rows explicitly — but every `dev:docker:up` leaked the
previous boot's vectors. Follow-up **`memory-vec-orphans-on-wipe`** covers
cleaning databases that already accumulated them.

### 5.4 — `abandonInactiveSince` expression index

Gated on 4.4 shipping, which it did. But 4.4's index carries a
`token_id`/`project_id` equality prefix and a `deleted_at IS NULL` partial clause
that this sweep has neither, so it cannot be served by it. Measured effect on the
candidate scan: none (1.56 ms against 1.76 ms, inside noise). No index added.

## Deferred by operator decision

Both settled in `design.md`'s "Resolved (operator decision, 2026-07-25)" before
implementation began. This change does not reopen either.

### 6.7 — `sessions` recency partial indexes

Q2 → `findActiveForTransport` only, because it runs on every MCP call. The
remaining session indexes are inconsequential below ~5k sessions and nobody is
near 50k.

### 6.9 — `memory_entities.link_count` and its triggers

Q1 → take `adminCountEntities`' free win, defer the counter. **The basis moved
and is recorded rather than acted on:** the decision rested on a 98.7 ms page,
and at the declared entity density the same page measures **1487 ms**, unmoved by
0027 (1508 ms) because the cost is aggregating the whole join. If this is
revisited it should be revisited against 1.5 s, not 98 ms.

### 9.6 — `link_count` trigger reconciliation

Moot: conditional on 6.9 shipping, which it did not.

## Follow-ups this change created

`serve-unarchived-scope-scan-without-displacing-recency` ·
`order-entity-fanout-by-link-pk` · `memory-vec-orphans-on-wipe`
