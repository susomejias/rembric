# Evidence — the rank window's recall half, owed by task 2.8 and closed here

Task 2.8 decided the rank-window policy on two grounds and recorded that a third was
missing: "the recall half was NOT measured … **The recall check is owed to phase 4**,
alongside task 4.13." Phase 2 could not take it because phase 3's corpus did not exist and
the volumetric corpus's vectors are pseudo-random, so any recall reading there would have
been a retrieval-quality claim that corpus forbids.

Phase 3's corpus now exists and phase 4's real widening now runs through it. This closes the
check, and the answer is **"measured, and non-discriminating"** rather than "confirmed".

## Instrument

`pnpm run eval` (`apps/server/src/test/retrieval/run-eval.ts`) against phase 3's committed
corpus and committed baselines, with phase 4's shipped retriever — one
`searchWithAbstention` call under a widened `SearchScope`, not phase 3's per-project
stand-in. Both arms are a single process run each; the harness is deterministic (a
re-ingest/re-evaluate diff runs inside it), so repeats add nothing here.

The divided arm is the only edit: in `denseRetriever`, `rankWindowSize` becomes
`Math.max(1, Math.ceil(rankWindowSize / partitionKeys.length))` at the kNN call. Applied by
hand, measured, restored, and the restore verified byte-identical against a pre-edit copy
(`git diff --stat` empty).

## Result — every gated metric is byte-identical

| arm         |    P@5 |    R@5 |  MRR@5 |    P@8 |    R@8 |  MRR@8 | `foreignScopeRate` |
| ----------- | -----: | -----: | -----: | -----: | -----: | -----: | -----------------: |
| window kept | 0.3100 | 0.9563 | 0.9167 | 0.2125 | 0.9750 | 0.9167 |                  0 |
| window ÷ N  | 0.3100 | 0.9563 | 0.9167 | 0.2125 | 0.9750 | 0.9167 |                  0 |

Both widened queries answer at rank 1 under both policies
(`q-widened-dunning-window` and `q-widened-backfill-watermark`, `reciprocalRank = 1`,
`recallAtK = 1`).

## The comparison is not vacuous — the divided window really applied

An unchanged metric is worth nothing without evidence that the change reached the code
under it. Census of the dense branch on the two widened queries, taken inside
`denseRetriever` for the runs above:

| arm         | raw neighbours returned | deduped pool handed to fusion |
| ----------- | ----------------------: | ----------------------------: |
| window kept |                      68 |                            64 |
| window ÷ N  |                      60 |                            60 |

**Eight candidates were cut and no metric moved.** So the divided window was in force; it
simply removed rows no gold set occupies.

## Why this corpus cannot discriminate, stated so the result is not over-read

The corpus is 70 memories over three projects — `atlas` 27, `nimbus` 27, `shared` 16 — and
the default page's window is `computeRankWindowSize(8, 0) = 64`. With the window kept,
`k = 64` per named partition already exceeds every project's row count, so "a full window"
IS the whole project and the two policies differ only in whether the two 27-row projects are
truncated to `ceil(64 / 3) = 22`. The eight rows that difference removes are the far tail of
the distance order.

**The decision therefore continues to rest on what phase 2 measured** — the pool-composition
census at 1 000 / 20 000 / 50 000 memories, where the quota is severely binding (a 16-row
project and a 600-row project each contributing exactly 10), and the 3.0–9.9% end-to-end cost
of keeping the window. This artifact removes an owed check; it does not add a second
independent reason.

**What would discriminate**, recorded so a later change does not repeat this run expecting
more: a corpus whose per-project row counts exceed the rank window, with gold placed below
the divided quota's cut in at least one project. That is a corpus phase 3 did not need and
this change did not build.
