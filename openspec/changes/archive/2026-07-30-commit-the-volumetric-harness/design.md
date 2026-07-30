## Context

`apps/server/src/scripts/` holds one generator, `seed-dev.ts`: 35 memories, one project, three tokens, five sessions, hand-authored so the dashboard and the MCP tools have something recognisable to show. It is a demo fixture and is good at that.

Nothing in the tree builds a corpus large enough to make a query plan misbehave. `tune-hot-query-paths` needed one and wrote it as scratch code, which is now gone; its `design.md` records the shape:

> Every query method in the thirteen repositories plus `db/diagnostics.ts` was audited with `EXPLAIN QUERY PLAN` and timed at 1k / 20k / 50k, on a corpus with realistic ~1.3KB bodies, 768-dim embeddings for every row, ~1.35 confirmations per memory, 6 scopes, and ~18 entities per memory (571MB file at 50k). Session-scoped findings were re-measured on a second corpus with 50 000 sessions.

Constraints this design has to respect:

- **The DELETE allow-list is sacred.** `invariants.test.ts` permits raw `DELETE FROM memory` in exactly `db/repositories/memory-repository.ts` and `scripts/seed-dev.ts`, and `CLAUDE.md` names the invariant suite as not-to-be-relaxed. A harness that wipes would need a third entry.
- **`dev:docker:up` runs `seed-dev --reset` on every boot.** That is how the resident 2 055-row corpus was destroyed during this batch of changes. Any new tool that can write to `data-dev` inherits the same hazard.
- **The primary detector is `EXPLAIN QUERY PLAN`, not wall-clock.** `tune`'s own design says so: "a `SCAN` is invisible at the 400 rows a real installation has today and fatal at 50k". The corpus exists to make the planner behave as it will in production, not to produce a benchmark number.
- **Derived tables are trigger-maintained or recipe-rebuilt.** `memory_fts`, `memory_replaces` and the three entity tables have their own invariants (`schema-inventory.ts` partitions them), so the harness must produce a corpus whose derived state is consistent, not one that looks right in `memory` and is empty everywhere else.

## Goals / Non-Goals

**Goals:**

- A committed, deterministic instrument that turns "we measured this at 50k" from a claim into a recipe.
- Cheap enough to actually be run: if generating 50k takes long enough to discourage a reviewer, the harness has failed at its only job.
- A corpus whose SHAPE is declared and asserted, so a figure citing "~18 entities per memory" can be checked.
- Structurally incapable of destroying data.

**Non-Goals:**

- Running `tune`'s measurements. This ships the instrument only.
- Replacing `seed-dev.ts`. Different job, different audience, no shared requirement.
- A benchmark suite with tolerance bands in CI. Deferred in the proposal, and it needs this to exist first.
- Semantic realism in the vectors (D2) or in the prose (D3).

## Decisions

### D1 — The harness refuses a populated database and never opens `data-dev`

It takes an explicit `--db <path>`, creates the file if absent, and exits non-zero if `memory` already holds rows. No `--force`, no `--reset`.

Two reasons, and the second is the stronger. The obvious one: adding a third entry to the `DELETE FROM memory` allow-list relaxes a sacred invariant, and a measurement tool has not earned that. The real one: this batch of changes already lost a corpus to a tool that wipes on start, and the lesson is not "be careful with the flag" — it is that a tool which cannot delete cannot be the cause. Refusing a populated database also makes the corpus reproducible by construction: you cannot accidentally measure a corpus that is 50k of generated rows plus whatever was already there.

_Alternative considered._ A `--force` behind an env gate, mirroring `seed-dev`'s `REMBRIC_ALLOW_DESTRUCTIVE_SEED`. Rejected: the gate exists on `seed-dev` because that script's whole purpose is to reset a dev stack. This one's purpose is to fill an empty file, and adding a destructive path so the caller does not have to type `rm` is not a trade worth an invariant.

### D2 — Vectors are deterministic pseudo-random, not embedded, and the harness says so

A 768-dim vector per row through the real embedder is minutes at 50k and buys nothing the measurements read. sqlite-vec brute-forces the partition before distance — `tune`'s own D-Q4 records `knnByQueryVector` as ~42 ms at 50k with `k` not the lever and cost linear in partition size — so plan shape and scan cost depend on how many vectors are in the partition, not on what the floats are.

What this makes unrepresentative, stated rather than left to be discovered: **recall and ranking are meaningless on this corpus.** Nothing about `hybridSearch`'s fusion quality, the abstention floor, or `RELATIVE_LEVEL_RATIO` may be argued from it. Those belong to `pnpm run eval` and its 40-item labelled corpus, which is a different instrument for a different question. The harness prints this in its own output so a figure copied out of it carries the caveat.

_Alternative considered._ Embed a small vocabulary of ~1 000 real sentences and reuse their vectors. Rejected: it costs the embedder dependency and startup, and it produces clustered vectors that are LESS representative of a real corpus's spread than uniform ones, while still not being a retrieval-quality instrument.

### D3 — Bodies are generated from a word list to a target length distribution, not lorem ipsum and not real text

FTS5 is a real consumer here — `memory_fts` is trigger-maintained and `searchBm25Ids` is on the per-turn path — so the bodies need a token distribution that produces a realistic index, not one long repeated token. A modest word list sampled to hit ~1.3 KB median with a long tail does that. Real text (this repo's commit bodies, say) would be more faithful but bounds the corpus at the number of commits and makes the generator depend on git history.

### D4 — Two independent axes, and the session axis is not derived from the memory axis

`--memories N` and `--sessions M` are separate. `tune` re-measured its session findings on a dedicated 50k-session corpus precisely because "sessions grows with agent activity rather than corpus size and the two do not track each other". A harness that generated sessions as a fixed ratio of memories would quietly make those findings unreproducible while looking like it covered them.

### D5 — Determinism via an explicit seed, defaulting to a fixed value

Same seed, same corpus, byte-for-byte. This is what makes a before/after comparison a comparison. `tune`'s own tasks record the cost of not having it: task 3.2 set out to reproduce an `adminList` plan coin-flip across "two independently-seeded 50k corpora" and could not — "**Not reproduced:** both seeds planned it identically". With a seeded generator that investigation is a one-line change instead of an open question.

### D6 — Derived state is produced by the real path, not written directly

Rows go in through the repositories, so `memory_fts` and `memory_replaces` are populated by their triggers and the entity tables by the real linking call. The harness never inserts into a derived table.

This costs generation speed — it is why §2 measures the cost rather than assuming it — and it is not negotiable: a corpus whose derived tables were hand-filled would measure the queries against state the application cannot produce, which is the failure mode the whole exercise exists to avoid. If the cost proves prohibitive at 50k, the honest response is to record the number and propose a faster path as its own change, not to bypass the triggers here.

## Risks / Trade-offs

- **[Risk] The harness's declared shape drifts from what it generates.** → Mitigation: the shape is asserted, not documented — a test generates a small corpus and checks the distribution against the declared constants. Same idiom as `supply-chain-inventory.ts` and `schema-inventory.ts`, both of which exist because a hand-maintained description of a fact diverged from the fact.
- **[Risk] Generation at 50k is slow enough that nobody runs it, so claims go back to being unrepeatable.** → Mitigation: §2 measures it and the number is published. If it is bad, that is a finding with a named cost, not a surprise. Partial mitigation available without new decisions: the axes are independent, so a session-only finding needs no 50k memory corpus.
- **[Trade-off] Synthetic vectors mean this corpus can never answer a retrieval-quality question.** → Accepted and stated in D2 and in the tool's own output. The alternative is a slower harness that still could not answer it.
- **[Trade-off] Refusing a populated database means the caller manages corpus files by hand.** → Accepted. `rm corpus-50k.db` is one command, and the failure it prevents cost this repo a corpus already.
- **[Risk] The new requirement in `data-access` reads as bureaucracy — "you must run a harness".** → Mitigation: it is scoped to a performance CLAIM recorded in a spec or change, not to every measurement. An ad-hoc timing in a comment is not what it governs.

## Open questions

Both were closed during apply rather than left to lapse. Recorded here, with the
deferral register in `deferred.md`.

1. **Should the harness emit a manifest alongside the corpus** (seed, sizes, shape, generator version, timestamp) so a `measurements.md` can cite one line instead of restating the parameters?

   **Resolved: no — the harness prints the invocation instead.** The leaning was yes; implementing the substitute is what changed it. The build's last lines are the exact command that rebuilds the corpus (`--db <dir> --memories N --sessions M --seed S`), which is the same information the manifest would have carried, at the moment the operator is looking at the terminal they will paste from.

   A file beside the corpus buys nothing over that and costs two things. It needs staleness rules that cannot be enforced: the harness refuses a populated database, so a manifest can never disagree with the corpus it sits beside _in place_ — but copy the directory, or copy the manifest alone into a change folder, and it becomes an unversioned claim about a corpus nobody can re-associate with it. And it points the obligation at the wrong artifact: the `data-access` requirement this change adds binds **the record of a claim** to carry its invocation, not the corpus directory to describe itself. A manifest invites citing the file when the requirement wants the figure and the command in the same paragraph.

   What would reopen this: a consumer that must read the parameters programmatically (a CI gate comparing two runs — see `deferred.md` 9.1). A printed line is for a human; that consumer would want structured output, and should add it with its own argument.

2. **What happens when the schema gains a table the harness does not populate?** `schema-inventory.ts` already enumerates every table and is asserted; the harness could read it and fail on an unpopulated source table it does not know about. Attractive, and out of scope here: it couples a dev tool to an invariant module and the coupling deserves its own argument.

   **Carried forward, named: `couple-volumetric-harness-to-schema-inventory`.** Not silently dropped — `deferred.md` 9.4 records the shape and names the hand-maintained list (`derivedStateProblems` in `seed-volumetric.test.ts`) that the follow-up would replace with a generated one.
