## Context

The v0.1 model treats `memory.save` as a pure write — the row goes in, and a nightly LLM pipeline figures out everything else. Three pressures push us off that model:

1. The judging agent needs _fresh context_. The nightly consolidator runs without the conversation that produced the memory; it can only inspect the rows. Engram, by contrast, surfaces the candidates at save-time and the same agent judges immediately with full context.
2. The same topic gets re-saved often. Without an explicit identity for "this is the latest version of an evolving fact", every save creates a new row and the consolidator merges them later — generating noise in `memory.search` in the meantime.
3. The consolidator is the most complex moving part of v0.1. Removing two of its three jobs (detection + judging) leaves it as a focused garbage collector: decay + orphan promotion. Less code, fewer LLM calls, easier to reason about.

### How the new save path looks

```
agent ─▶ memory.save({type, content, topic_key?})
              │
              ▼
        1. Insert row (atomic, status='active')
              │
              ▼
        2. If topic_key supplied:
              find previous active row with same
              (scope, project_id, topic_key);
              if found, transition it to 'superseded'
              and add its id to new row's replaces[].
              │
              ▼
        3. Run candidate detection:
              FTS5 lexical neighbors (always)
            + vec kNN neighbors (when EMBEDDING_ENABLED)
              over rows in the same (scope, project_id),
              excluding the just-inserted row and rows already
              linked via replaces[].
              │
              ▼
        4. For each candidate above the threshold:
              insert memory_relations row
              (source_id = new id, target_id = candidate,
               status = 'pending', judgment_id = ulid()).
              │
              ▼
        5. Return {
              id, status, createdAt,
              candidates: [{ judgmentId, targetId, snippet,
                             similarity, source: 'fts' | 'vec' }],
              judgmentRequired: candidates.length > 0
           }
```

The save always succeeds in step 1. Steps 2–4 are best-effort and run inside the same transaction as the insert — if they fail, the insert is rolled back too (atomic guarantee).

### How the agent closes the loop

```
agent reads response, decides per candidate:
   - "not relevant"    → memory.judge({judgmentId, relation: 'not_conflict'})
   - "they say similar things, supplement"
                       → memory.judge({..., relation: 'related'})
   - "new replaces old"
                       → memory.judge({..., relation: 'supersedes'})
                         (server transitions target to superseded,
                          appends target.id to source.replaces[])
   - "they contradict, neither wins"
                       → memory.judge({..., relation: 'conflicts_with'})

proactive comparison of two random memories:
   - memory.compare({memoryIdA, memoryIdB, relation, reason, confidence})
```

## Goals / Non-Goals

### Goals

- Conflict detection happens with the agent that produced the conflict in scope.
- A single tool call (`memory.save({topic_key})`) is enough to evolve a topic without creating fragmenting rows.
- The consolidator's LLM bill drops to "only the unjudged tail", not "every potential pair every night".
- The search results show provenance: which memory supersedes which, which conflict with which, which are still pending judgment.
- Backwards compatible: agents that ignore `topic_key`, never call `memory.judge`, and ignore the new response fields continue to work; the consolidator picks up their unjudged pairs.

### Non-Goals

- Real-time multi-agent agreement on judgments. Two agents judging the same pair persist as separate rows; reconciliation is deferred.
- Migrating existing v0.1 rows to fit the new model. Pre-existing rows keep `topic_key = NULL` and have no auto-generated relation rows.
- Replacing the consolidator's reversibility. Undo of any consolidation op still works the same way; the smaller pipeline retains journaling.

## Decisions

### Decision 1: Why insert the relation row at save-time, not after the agent judges?

Two reasons. First, the agent might never call `memory.judge` (it crashes, the operator force-quits the terminal, the session times out). Without a pending row, the candidate is lost — the next save won't re-discover it because the new save's candidates are about _that_ save, not retroactive. Inserting a pending row at save-time makes the orphan visible to the consolidator and to the dashboard.

Second, it gives the agent an opaque `judgmentId` to pass back, decoupling the verdict call from re-deriving the pair. The agent can hold onto the id while it does other tool calls, then judge later.

### Decision 2: How many candidates do we surface per save?

Cap at 5 by default, configurable via env `CANDIDATES_PER_SAVE_MAX` (range 0–25). Beyond five, the agent is unlikely to read carefully; judgment fatigue degrades quality. The cap is on the _number returned to the agent_, not on the number inserted into `memory_relations` — if FTS5 + vec find 15 above threshold, the top 5 surface; the rest are silently left for the consolidator's orphan-promotion pass.

If the cap is `0`, candidate detection runs and inserts pending rows but the response carries `candidates: []` and `judgmentRequired: false`. This is useful for batch/automation paths (SDD imports, scripted backfills) that want to avoid prompting the agent at all.

### Decision 3: `topic_key` semantics in detail

`topic_key` is a string ≤ 128 chars, free-form but conventionally `slug/slug` (e.g., `architecture/auth`, `bug/n+1-userlist`, `decision/redis-vs-sqlite`). The server does NOT enforce a structure beyond max length and the absence of NUL bytes — Engram and Rembric should be compatible at this layer.

On save:

```
SELECT id FROM memory
 WHERE scope = ?
   AND (project_id = ? OR (? IS NULL AND project_id IS NULL))
   AND topic_key = ?
   AND status = 'active'
 LIMIT 1
```

If found, the new row's `replaces` array prepends the found id, and the same transaction transitions the found row's status to `superseded`. The relation between them is recorded in `memory_relations` with `relation = 'supersedes'` and `status = 'judged'` (because the upsert is the agent's explicit declaration of supersedence), `marked_by_kind = 'agent_topic_key'`.

`topic_key` lookup is a partial index on `(scope, project_id, topic_key) WHERE status = 'active'` — fast even on millions of rows, and the partial filter keeps the index small.

### Decision 4: Candidate detection scoring and threshold

Three signals, ranked by certainty:

1. **Vec cosine similarity** (when EMBEDDING_ENABLED) — top-K from `memory_vec` via sqlite-vec, K=20, cosine ≥ 0.85 threshold.
2. **FTS5 BM25 rank** — top-K from `memory_fts`, K=20, rank score normalized to a [0,1] proxy via `(1 / (1 + |rank|))`, threshold 0.4.
3. **Same topic_key** — when the just-saved row has a `topic_key`, ALL active rows with that key are emitted as candidates (already handled by the upsert path).

The union of (1) and (2), deduplicated by target id, is taken; top 5 by max(vec, fts) are returned. The thresholds are configurable via env (`CANDIDATE_VEC_THRESHOLD`, `CANDIDATE_FTS_THRESHOLD`).

Embeddings being disabled does not break the path: FTS5-only is the fallback. The candidates returned in that mode include `source: 'fts'` so the agent knows it's a lexical match, not a semantic one.

### Decision 5: `memory.judge` relation taxonomy

Six relations, matching Engram so an agent prompted for either tool emits the same vocabulary:

| Relation         | Persisted? | Side effect on memory rows                                                                                    |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `supersedes`     | yes        | target row → `superseded`; source's `replaces` includes target                                                |
| `conflicts_with` | yes        | none                                                                                                          |
| `related`        | yes        | none                                                                                                          |
| `compatible`     | yes        | none                                                                                                          |
| `scoped`         | yes        | none (different scopes / contexts, both valid)                                                                |
| `not_conflict`   | no (acked) | nothing — false positive, row is updated to `status='judged'`, `relation='not_conflict'` but no row mutations |

The only relation with a side effect on `memory` rows is `supersedes`. All other relations are purely annotative — they shape what `memory.search` reports but do not change which rows are active.

### Decision 6: `memory.compare` is a peer of `memory.judge`, not a wrapper

`memory.judge({judgmentId, relation, ...})` closes a pending row that was created by `memory.save`. `memory.compare({memoryIdA, memoryIdB, relation, ...})` creates a new relation row directly, without a preceding save. Both write into the same `memory_relations` table.

`memory.compare` is for agent-initiated proactive analysis: the agent reads two memories, decides one supersedes the other (or they conflict), and wants to record that. The new row has `status='judged'` from the start (there was never a pending phase).

Idempotency: if `memory.compare` is called twice with the same `(source, target)` pair, the existing row is updated (relation, reason, confidence). Two distinct agents calling with different verdicts persist as separate rows (Engram's Phase-1 model).

### Decision 7: Consolidator becomes decay + orphan promotion

The new consolidator pipeline, per scope:

1. **Decay** (unchanged): mark memories `archived` if `last_seen_at` is older than `DECAY_THRESHOLD_MS` and confidence is below floor.
2. **Orphan promotion**: query `memory_relations WHERE status='pending' AND created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`. For each, run the existing LLM judge (which already knows merge/supersede/keep_separate). Translate its output into the new taxonomy (`merge` → `supersedes` on the older; `keep_separate` → `not_conflict`). Write the verdict. If the LLM judge itself fails or returns low confidence, mark `status='orphaned'`.

The old `findRedundancyCandidates` / `findDriftCandidates` / `findContradictionCandidates` code paths are removed. The detector job they used to do is now done at save-time, where it belongs.

The `JUDGMENT_ORPHAN_AFTER_MS` default is `24 * 3600 * 1000` (24h). It is configurable.

### Decision 8: Search results carry compact relation annotations

Engram's format, slightly simplified:

```json
{
  "id": "01HX...",
  "type": "decision",
  "content": "...",
  ...
  "relations": [
    { "kind": "supersedes",         "targetId": "01HW...", "snippet": "..." },
    { "kind": "superseded_by",      "targetId": "01HY...", "snippet": "..." },
    { "kind": "conflicts_with",     "targetId": "01HZ...", "snippet": "..." },
    { "kind": "pending_conflict",   "targetId": "01HV..." }
  ]
}
```

The annotations are JOINed in a single SQL pass — no N+1 — by selecting from `memory_relations WHERE source_id = m.id OR target_id = m.id`. Existing tests assert no N+1 patterns; the impl must keep that promise.

Annotation cap: at most 10 relations per memory in the search response (configurable). If a memory accumulates more, the dashboard shows the rest.

### Decision 9: Migration plan for `memory_relations` and `topic_key`

Migration `0005_relations_and_topic_key.sql`:

- `CREATE TABLE memory_relations` with the columns described in the persistence spec.
- `ALTER TABLE memory ADD COLUMN topic_key TEXT` (nullable, no backfill).
- `CREATE INDEX memory_topic_key_active_idx ON memory(scope, project_id, topic_key) WHERE status = 'active' AND topic_key IS NOT NULL`.

No backfill. Existing memories continue with `topic_key = NULL`, which means they fall back to the FTS5 / vec candidate detection path on next save, never on their own.

The migration is forward-only. Reverting it would lose the relation graph, so the change is documented as "after applying, downgrading is unsupported without a backup restore".

### Decision 10: What happens to the existing v0.1 consolidator code?

It is deleted, not feature-flagged. The runner module keeps `applyDecay` + the new `promoteOrphans` step. The old `applyMerge` / `applySupersede` operations (used by the LLM judge) are retained because the orphan-promotion path uses them. The detector functions (`findRedundancyCandidates`, `findDriftCandidates`, `findContradictionCandidates`) and their tests are removed.

This avoids carrying dead code "just in case" — git history is the rollback plan. The PR diff will be large but mostly deletions in `src/consolidation/`.

### Decision 11: Why not allow `memory.judge` to also CREATE relations between arbitrary memories?

`memory.judge` is bound to a `judgmentId` returned by a previous `memory.save`. That contract is the safety mechanism: the source row of the judgment is known to be the just-saved one, and the target is known to be a server-vetted candidate. If we let `memory.judge` accept arbitrary `(source, target)` pairs, we lose the property that "judgments correspond to candidates the server thought were close" — every pair becomes free-form.

`memory.compare` exists exactly for the free-form case. Keeping the two surfaces distinct makes the agent's mental model cleaner: "I'm closing a save-time candidate" vs. "I'm reporting a finding from independent analysis".

### Decision 12: Authorization

The new tools follow existing scope rules. `memory.save` is unchanged. `memory.judge` and `memory.compare` require write authorization on the scope of the involved memories: if the relation's source and target span (scope, project), the call is rejected with `scope_locked`. A `read:*` token cannot call either tool; it can only see annotations in `memory.search` results.

## Risks / Trade-offs

- **Save latency.** Adding vec kNN + FTS5 to every save adds 5–50ms depending on DB size. Mitigation: the operations are bounded (K=20 per source, capped result), the indexes already exist, and the threshold filtering keeps the response small.
- **`topic_key` collisions across agents.** Two agents using different conventions for the same logical topic (`architecture/auth` vs `arch/auth`) end up not converging. Mitigation: ship `memory.suggest_topic_key` and document the canonical convention in tool descriptions; encourage one-call-then-reuse.
- **Pending relations accumulate if agents don't judge.** The orphan-promotion path picks them up after 24h, but in the interim `memory.search` shows `pending_conflict` annotations. Mitigation: the annotation is informational; results still rank by FTS5/vec, not by relation count.
- **Consolidator simplification loses some detection.** The old pipeline scanned the entire DB nightly looking for pairs no agent had touched. The new path only knows about pairs that surfaced at save-time or via `memory.compare`. Cold pairs (two memories saved a year apart by different agents, never re-read) may stay unrelated forever. Mitigation: this is acceptable for v0 — research agents touch memories often enough that "saved a year apart, never re-read" is rare; the dashboard provides a manual "scan for candidates" button (out of scope for this change, but easy to add).
- **Backwards-compat with v0.1 agents.** Agents that ignore `candidates[]` in the save response still work — they just don't judge, and the consolidator picks up after them. Agents that send `topic_key` against a server that doesn't know it (i.e., before this change) fail with a schema error; the migration is required before agents start sending the field.

## Migration Plan

This change ships against a database whose schema is v0.1 plus change #1 (`add-sessions-and-research-tools`). It requires change #1's migrations to be applied first. Order:

1. Stop server (or rely on the migrate-on-startup path).
2. Migration `0005_relations_and_topic_key.sql` applies.
3. New consolidator code starts. The old code is gone.
4. New tool descriptions go live. Agents on next `tools/list` see `memory.judge`, `memory.compare`, `memory.suggest_topic_key`.
5. Agents that already had pending judgments? None — this is the first version that emits them, so the starting state is empty for both tables.

The migration is idempotent under the existing migrations runner.

## Open Questions

1. Should `memory.suggest_topic_key` be deterministic (a JS function on `type + title`) or backed by an LLM call? — **Deterministic**, no LLM. Same as the slug-derivation choice in change #1. Speed and determinism win.
2. When a `topic_key` upsert collides with an in-flight save-time candidate detection (race: two agents save with the same key concurrently)? — Both inserts succeed (each in its own transaction); the loser sees the winner as a candidate on its own response, and the next agent action judges it.
3. Should `memory.compare` reject pairs where one side is `archived`? — No. The annotation is informational; the agent can record a verdict about historical context.
