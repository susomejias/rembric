## Context

`services/review.ts` derives review state from `(type, created_at, last affirming confirmation, last refuting confirmation)`. The SQL half of that derivation lives in `memory-repository.ts::needsReviewExprs`, which builds a correlated subquery per candidate row of the shape:

```sql
(SELECT MAX(event_ts) FROM confirmations
  WHERE memory_id = memory.id AND verdict = 'affirm')
```

`findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` all compose it, so all four scale the same way.

## Decisions

**D1 — Index, do not rewrite.** The correlated-subquery form stays. Two alternatives were measured against it on a migrated temp DB, and both lost:

- The `LEFT JOIN` + `GROUP BY` rewrite wins by ≤20% at 20 000 active rows and loses at 50 000 (56.3 ms against 36.6 ms), because it materialises two grouped subqueries over the whole of `confirmations` regardless of how few candidates survive the outer predicate. The correlated form does work proportional to the candidates it actually visits.
- Hoisting the WHERE and ORDER BY expressions into a computed subquery is slower at every size tested (28.5 against 24.6 ms at 20 000), with verified-identical result sets.

Neither removes the `O(active rows)` scan, which is inherent: the predicate is a function of each active row's own type and timestamps, so every active row must be considered.

**D2 — Column order is `(memory_id, verdict, event_ts)`.** Equality on `memory_id` first, then equality on `verdict`, then `event_ts` last so `MAX(event_ts)` is answered from the index's ordering rather than by scanning matched rows. That also makes the index covering for these subqueries — no table access at all. Any other order loses one of the three properties.

**D3 — The measurement goes in the spec, not only in a commit message.** The deferral this change closes existed because nobody had numbers. Recording the figures as a requirement is what stops the join being re-proposed as an obvious win in six months. This is the same reasoning `memory-entities/spec.md` applies to entity kinds: a change to a hot read must earn its place against a measured baseline.

## Open questions

**Q1 — Drop `confirmations_memory_id_idx`?** The composite's leftmost column makes it capable of serving every lookup the single-column index serves, so keeping both means two index writes per confirmation insert on a table that is append-only and only grows. Against that: SQLite may still prefer the narrower index for a bare `memory_id` seek (`countConfirmations`, `insertConfirmation`'s uniqueness path), and dropping an index is harder to reverse than not creating one. Measure both shapes before deciding; default to keeping it if the difference is inside noise.

**Q2 — Does `confirmations_event_ts_idx` still earn its place?** Unrelated to this change's hot path, but worth checking while the harness exists: if nothing queries `event_ts` without a `memory_id`, it is pure write cost. Do not remove it in this change without its own measurement.

## Risks

- **Low blast radius, easy to over-scope.** This is one `CREATE INDEX`. The temptation is to also rewrite the query while touching the area — D1 exists precisely to say no, with numbers.
- **The figures are from this box.** They establish the _ordering_ of the alternatives, which is what the decision rests on, not absolute latency on any given host. State them as measured-relative, not as guarantees.
- **`memory.context` still pays the predicate twice** (page plus total). The index makes both cheaper but does not merge them; that is a separate finding, tracked in `reconcile-specs-with-shipped-behaviour`.
