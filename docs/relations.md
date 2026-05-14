# Memory relations

The `memory_relations` table records the judgment graph between memories. Each row represents one of:

- a **candidate** detected at `memory.save` time and awaiting agent judgment (`status='pending'`, `relation=null`)
- a **judged verdict** — either from the agent (`memory.judge` / `memory.compare`) or from the consolidator's orphan-promotion pass (`status='judged'`, `relation` set, `marked_by_kind` set)
- an **orphan** that neither the agent nor the consolidator could resolve (`status='orphaned'`, `relation=null`)

## Lifecycle

```
   memory.save          memory.judge        consolidator
   surfaces a            closes the          orphan-promote
   candidate             pending row         pass
        │                     │                    │
        ▼                     ▼                    ▼
    pending ─────────────▶ judged ─────────▶ (terminal)
        │
        ▼
    orphaned ────────────▶ (terminal — re-judging not allowed)
```

- A row stays `pending` until either the agent calls `memory.judge({judgmentId, …})` with the `judgmentId` returned by save, or the consolidator picks it up after `JUDGMENT_ORPHAN_AFTER_MS` (default 24h).
- The consolidator's orphan-promotion pass invokes the LLM judge over the (source, target) pair. A confident verdict transitions the row to `judged`; a failure marks it `orphaned`.
- `memory.compare` writes `status='judged'` directly — there is no preceding pending phase.

## Relation taxonomy

Six possible values; each has a different effect on the underlying `memory` rows.

| Relation         | Persisted on `memory_relations`? | Side effect on `memory` rows                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `supersedes`     | yes                              | target → `status='superseded'`; source's `replaces[]` gains the target id |
| `conflicts_with` | yes                              | none                                                                      |
| `related`        | yes                              | none                                                                      |
| `compatible`     | yes                              | none                                                                      |
| `scoped`         | yes                              | none — both are valid in different sub-contexts                           |
| `not_conflict`   | yes (status='judged')            | none — acknowledged false positive; hidden from search annotations        |

Only `supersedes` mutates `memory` row status. All other relations are pure metadata: they shape what `memory.search` reports but do not change which rows are active.

`memory.compare` rejects `relation='not_conflict'` (the relation is for closing a save-time pending candidate that turned out to be a false positive; it makes no sense as a proactive verdict).

## Search annotations

Every result row from `memory.search` and `memory.get` carries a `relations` array. Each entry is one of:

```ts
{ kind: 'supersedes',         targetId, reason?, confidence?, status: 'judged' }
{ kind: 'superseded_by',      targetId, reason?, confidence?, status: 'judged' }
{ kind: 'conflicts_with',     targetId, ..., status: 'judged' }
{ kind: 'related' | 'compatible' | 'scoped', targetId, ..., status: 'judged' }
{ kind: 'pending_conflict',   targetId, judgmentId, status: 'pending' }
```

- `supersedes` / `superseded_by` are point-of-view variants of the same row — search results show whichever direction the memory itself is on.
- `pending_conflict` rows include the `judgmentId` so the agent can call `memory.judge` on it directly from search results.
- `not_conflict` and `orphaned` annotations are **hidden** from search; they're admin-only and surface on the dashboard.

The annotation set is capped at 10 per memory in search responses (configurable). `memory.get` returns up to 50.

The query is a single JOIN against `memory_relations` keyed by both source_id and target_id; there is no N+1.

## When to call which tool

| Situation                                               | Call                                           |
| ------------------------------------------------------- | ---------------------------------------------- |
| Save a memory that evolves a topic you've saved before  | `memory.save({topic_key})`                     |
| Don't know the canonical topic_key                      | `memory.suggest_topic_key` first, then save    |
| Save returned `candidates[]` and you want to close them | `memory.judge({judgmentId, relation})`         |
| Two arbitrary memories you analyzed independently       | `memory.compare({memoryIdA, memoryIdB, …})`    |
| Search results have `pending_conflict` annotations      | `memory.judge` using the embedded `judgmentId` |

See [docs/agents.md](./agents.md) for the full tool surface and [docs/troubleshooting.md](./troubleshooting.md) for the "too many pending judgments" symptom.
