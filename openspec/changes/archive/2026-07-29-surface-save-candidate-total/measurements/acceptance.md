# Acceptance bar — prove the hot path did not move (task 5)

## 5.1 Query-count proof — the primary bar, and it is EXACT

Instrumented `better-sqlite3`'s `prepare` on a **fresh connection opened over the corpus file
after it was built**, wrapping each returned statement's `run`/`get`/`all`/`iterate`. The fresh
connection matters: drizzle reuses statements it prepared while building the corpus, so a
counter installed on the original connection sees only 3 of the 19 statements and would have
reported a bogus "no change" from a near-blind instrument. Two earlier attempts undercounted
for exactly that reason before the harness was validated against a plain single save (1
statement, the `insert into memory`).

One `memory.save` over a 12-row corpus of lookalikes, cap 5, detection ranking 12:

|                                 | statements                    | composition              |
| ------------------------------- | ----------------------------- | ------------------------ |
| **before** (HEAD, field absent) | **19** prepared / 19 executed | as below                 |
| **after** (this change)         | **19** prepared / 19 executed | identical, line for line |

```
 10x select "scope", "project_id", "replaces" from "memory" where "memory"."id" = ?
  5x insert into "memory_relations" (...)
  1x insert into "memory" (...)
  1x SELECT embedding FROM memory_vec WHERE memory_id = ?
  1x SELECT m.id, memory_fts.rank, ... (the bm25 candidate query)
  1x insert into "memory_entity_scan" ("memory_id", "scanned_at") ... on conflict do nothing
```

**Exactly equal**, which is what design.md D1 requires: the count is `all.length`, read off an
array the ranking already materialised, so it cannot cost a statement. The pre-change run
reported `candidatesDetected: ABSENT`, confirming the two builds really were different.

(The 10 scope reads are 2 per `createPending` — source and target — not the `replaces` walk,
which does nothing here because `replaces[]` is empty on a non-`topic_key` save.)

## 5.2 Wall-clock — inside the noise band

Noise band established first by running the **pre-change** build twice, as the task requires.
40 saves per size, first 5 dropped as warm-up.

| rows   | before (2 runs)                             | after (2 runs)                              | verdict                                                                             |
| ------ | ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1 000  | median 2.72 / 2.77 ms · p95 3.70 / 4.10     | median 2.75 / 2.85 ms · p95 3.59 / 3.74     | median +3.8% vs the pre-change mean, inside ±5%; p95 **below** both pre-change runs |
| 20 000 | median 26.69 / 27.12 ms · p95 27.86 / 28.65 | median 26.91 / 26.95 ms · p95 28.47 / 28.78 | median inside the pre-change spread; p95 +0.5%                                      |

**50 000 rows was not measured.** 5.1 is exactly equal and the only added work is reading
`.length` off an existing array, so the 50k point would test the noise band rather than the
change. Recorded as an omission rather than passed over.

## 8.1 Post-deploy distribution — not collected

This is a post-deploy observation over a day of real saves on the populated instance and
cannot be produced from a development tree. It remains the open question design.md names, and
`before.md` above is the pre-deploy stand-in, not a substitute.

## Docker smoke (task 7) — NOT run

Task 7.1 calls for `dev:docker:up`, which wipes and reseeds `data-dev` — and `data-dev`
currently holds the 2055-row corpus the operator asked to keep for device testing. Destroying
it to run a smoke was not a trade worth making unsupervised. Consequently unverified by this
change: 7.3 (doctor pending-count delta equals `candidates.length`), 7.4/7.5 (live
`candidatesDetected` over `/mcp/<slug>` and `capture_passive`), 7.6 (re-deriving the tail with
`memory.search` against real data), 7.7 (`/dashboard/judgments` unchanged by the new field) and
7.8 (rollback rehearsal on the previous image). The queue-growth guarantee 7.3 checks IS
covered at the unit level — `memory-tools.test.ts` asserts the pending row count equals
`candidates.length` and NOT `candidatesDetected` — but not against a real container.
