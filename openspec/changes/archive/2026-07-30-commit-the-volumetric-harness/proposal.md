## Why

Every performance claim this repo has made was measured against a corpus that no longer exists and that nothing in the tree can rebuild.

`tune-hot-query-paths` audited all thirteen repositories at **1k / 20k / 50k memories** — ~1.3 KB bodies, a 768-dim vector per row, ~1.35 confirmations per memory, 6 scopes, ~18 entities per memory, a 571 MB file at 50k — plus a second corpus of **50 000 sessions**, because `sessions` grows with agent activity rather than with corpus size. Its groups 1–3 landed on that evidence. Its remaining **36 tasks** cannot be verified without it, and neither can any of their claims be re-checked by a reviewer: the generator was scratch code in a session that ended, and `apps/server/src/scripts/` holds only `seed-dev.ts`, which produces **35** memories.

This is not a one-change problem. Three separate changes this week recorded figures they could not re-derive. `recalibrate-entity-rarity-threshold` had to mark its dev-corpus reality check "not re-derivable" in `measurements.md`. `order-entity-projection` reached for the resident dev corpus, found it took every gate decision at a single `A`, and rejected it as an instrument. The measurement discipline these changes practise — every ratio with its denominator, every claim re-run rather than quoted — is the discipline that caught six real defects in code that was already green. A harness that only ever exists in scratch buffers makes that discipline unrepeatable by anyone but the author, on the day they wrote it.

The trigger is concrete: `tune-hot-query-paths` is blocked on it today.

## What Changes

- **A committed volumetric harness** at `apps/server/src/scripts/`, invoked as a script, that builds a corpus of a requested size and shape into a database path the caller names. It is the reproduction recipe for a performance claim, in the same way `measurements.md` is the record of one.
- **It never deletes.** It refuses to run against a database that already holds memories, and it never opens `data-dev`. This is deliberate and load-bearing twice over: the `DELETE FROM memory` allow-list in `invariants.test.ts` names exactly two files and relaxing a sacred invariant to add a third is a far larger decision than this change earns; and a wipe-capable measurement tool is how the resident dev corpus was destroyed in the first place.
- **Vectors are synthetic, not embedded.** A 768-dim vector per row at 50k through the real embedder costs minutes and adds nothing: sqlite-vec brute-forces the partition before distance, so plan shape and scan cost are independent of what the floats contain. The harness writes deterministic pseudo-random unit vectors and says so, rather than quietly implying its `knnByQueryVector` numbers describe real semantic distances. Argued in design D2; the one figure this makes unrepresentative is named there.
- **Two axes, because they do not track each other**: memory count and session count. `tune`'s session findings were re-measured on a separate 50k-session corpus for exactly this reason, and a harness that only scales memories would silently make those findings unreproducible.
- **Deterministic**: a seed produces a byte-identical corpus, so two people comparing a before and an after are comparing the same thing. The alternative — a fresh random corpus per run — is how `tune` got a plan coin-flip it could not reproduce (`tasks.md` 3.2 records the "adminList plan coin-flip: **not reproduced**").
- **The shape is declared, not implied.** The generator states the distribution it produces — body length, entities per memory, confirmations per memory, scope spread, superseded fraction — and a test asserts the generated corpus matches it, so a claim citing "~18 entities per memory" can be checked rather than trusted.
- **Not in scope**: running the measurements. This change ships the instrument; `tune-hot-query-paths` groups 4–9 remain that change's work. No production code path is touched, no query is rewritten, no index is added.

## Capabilities

### New Capabilities

_None._ A `data-access` capability already owns the measured index contract and will carry `tune`'s index basis; `development-environment` already owns the repo's script and file-shape requirements. A harness is an instrument for those, not a capability of its own.

### Modified Capabilities

- `data-access`: **ADDED** one requirement — a performance claim recorded against this repo SHALL be reproducible by a committed harness at a stated corpus size and shape, rather than by a figure quoted from a corpus that no longer exists. This is the requirement `tune-hot-query-paths` needs in order for its own measured basis to mean anything a year from now.
- `development-environment`: **ADDED** one requirement for the harness itself, alongside the existing `seed-dev.ts` requirement rather than folded into it. The non-destructive constraint is normative — it refuses a populated database and never touches `data-dev` — so a future contributor cannot "helpfully" add a `--reset` to it. Added rather than modified deliberately: the seed-dev requirement is long, is about a different script, and republishing it whole to hang a second one off it is exactly the staleness hazard `check-delta-freshness.mjs` now guards against. This change carries no `MODIFIED` block at all.

## Impact

- **New**: `apps/server/src/scripts/seed-volumetric.ts` and its co-located test asserting the generated distribution matches the declared one.
- **Modified**: `package.json` (one script entry), and at archive time only `openspec/specs/{data-access,development-environment}/spec.md`.
- **Deliberately unchanged**: `apps/server/src/scripts/seed-dev.ts` (a different job — a small, hand-authored demo corpus), `apps/server/src/test/invariants.test.ts` (the DELETE allow-list is NOT widened; the harness never deletes), every repository, every migration, `apps/plugin/`.
- **No load-bearing invariant crossed.** Append-only is untouched — the harness only inserts, into a database it requires to be empty of memories. No schema change, no migration, no derived-table invalidation of an existing installation: the harness writes to a path the caller names, and nothing in the shipped image invokes it.
- **Cost to be measured, not assumed** (tasks §2): wall-clock and file size at each of 1k / 20k / 50k, plus the 50k-session corpus. `tune` recorded 571 MB at 50k; if generation takes long enough to discourage use, that is a finding about the harness and belongs in its own `measurements.md` rather than being discovered by the next person who tries.
- **Deferred, recorded so it is not lost**: (a) whether CI should run a reduced-size version of the measurements as a regression gate — a real question, but it needs the harness to exist and a decision about tolerance bands before it can be argued; (b) whether `seed-dev.ts`'s demo corpus should be expressed in terms of the harness, which would couple a stable operator-facing fixture to a measurement tool for no measured benefit.
