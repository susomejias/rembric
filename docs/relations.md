# Memory relations

The `memory_relations` table records the judgment graph between memories. Each row is one of:

- **candidate** — detected at `memory.save` time, awaiting agent judgment (`status='pending'`, `relation=null`).
- **judged verdict** — from the agent (`memory.judge` / `memory.compare`) (`status='judged'`, `relation` set, `marked_by_kind` set).
- **orphan** — no agent closed it before the deadline; the deterministic sweep retired it (`status='orphaned'`, `relation=null`).

## Lifecycle

```
   memory.save          memory.judge          sweep
   surfaces a            closes the           deadline
   candidate             pending row          orphaning
        │                     │                    │
        ▼                     ▼                    ▼
    pending ─────────────▶ judged ─────────▶ (terminal)
        │
        ▼
    orphaned ────────────▶ (terminal — re-judging not allowed)
```

A row stays `pending` until an agent closes it via `memory.judge({judgmentId})`. After `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) it re-surfaces in `memory.context.pendingJudgments[]` so any later session can judge it with fresh context; after `JUDGMENT_ORPHAN_DEADLINE_MS` (default 14 days) the deterministic sweep marks it `orphaned` (journaled, undoable). `memory.compare` writes `status='judged'` directly with no preceding pending phase.

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

Every `memory.search` / `memory.get` result carries a `relations` array:

```ts
{ kind: 'supersedes' | 'superseded_by',          targetId, reason?, confidence?, status: 'judged' }
{ kind: 'conflicts_with' | 'related' | 'compatible' | 'scoped', targetId, ..., status: 'judged' }
{ kind: 'pending_conflict',                      targetId, judgmentId, status: 'pending' }
```

- `supersedes` / `superseded_by` are POV variants of the same row.
- `pending_conflict` rows include the `judgmentId` so the agent can call `memory.judge` directly from search results.
- `not_conflict` and `orphaned` annotations are hidden from search (admin-only on the dashboard).

Cap: 10 per memory in search, 50 in `memory.get`. One JOIN keyed on both source_id and target_id — no N+1.

## When to call which tool

| Situation                                          | Call                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| Save a memory that evolves a known topic           | `memory.save({topic_key})`                     |
| Don't know the canonical topic_key                 | `memory.suggest_topic_key` first, then save    |
| Save returned `candidates[]`                       | `memory.judge({judgmentId, relation})`         |
| Two arbitrary memories analyzed independently      | `memory.compare({memoryIdA, memoryIdB, …})`    |
| Search results have `pending_conflict` annotations | `memory.judge` using the embedded `judgmentId` |
| `memory.context` returned `pendingJudgments[]`     | `memory.judge` each entry's `judgmentId`       |
