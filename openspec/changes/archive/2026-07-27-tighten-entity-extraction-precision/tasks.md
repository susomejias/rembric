## 1. Reset path first (defect C) — must be sound before the version bump fires

- [x] 1.1 Add `pending?: boolean` to `EntityState` in `apps/server/src/services/entity-state.ts` and make `readMarker` report the flag; treat an ABSENT `pending` as complete (design.md D4 — markers written by 0.24.x predate the protocol, and treating absence as pending would rebuild the index on an ordinary deployment, violating `memory-entities/spec.md:291-295`).
- [x] 1.2 Make `ensureEntityExtractor` two-phase: write `{extractorVersion, pending: true}` BEFORE `resetEntityIndex`, then rewrite `{extractorVersion, pending: false}` after it returns. Keep marker-before-wipe ordering intact — commit `fc6e2ff` established it and a full or read-only `dataDir` must still throw before anything is destroyed.
- [x] 1.3 Make the identity check treat `pending === true` as a mismatch, so a marker left pending re-fires the reset on the next boot.
- [x] 1.4 Verify `apps/server/src/server/bootstrap.ts:204`'s `try` still wraps the whole call and that `entityBackfillTick(true)` remains OUTSIDE it. `fc6e2ff` fixed a boot-blocking, index-destroying failure on a full `dataDir`; this change must not reintroduce "no boot until disk frees". Verified: the `try` ends before `entityBackfillTick(true)` (bootstrap.ts:225 vs :252). DEVIATION: the catch's message claimed "leaving index as-is", which the new settle-write failure path makes false (the wipe has committed by then), so it now says "re-checking next boot".
- [x] 1.5 In `apps/server/src/services/entity-state.test.ts`, add the second-clause test for `memory-entities/spec.md:259-262`: inject a `TransactionRunner` whose `transaction` throws, then assert (a) the on-disk marker does NOT claim the new recipe as complete, (b) a second `ensureEntityExtractor` call with a working runner still resets, and (c) after that second call `adminBacklogCount()` is non-zero rather than zero. The existing test at `:110-132` covers only the first clause and stays green.
- [x] 1.6 Add a test that a marker with NO `pending` field and a MATCHING version does not reset — the `spec.md:291-295` guarantee.
- [x] 1.7 Add a test that a failure of the FINAL marker write (after a successful wipe) leaves the marker pending, so the next boot resets idempotently rather than stranding the corpus.

## 2. Bare-dotfile precision (defect A1)

- [x] 2.1 Declare a closed dotfile-NAME list in `apps/server/src/services/extractor-rules.ts` beside `PATH_EXT`, matched CASE-SENSITIVELY (design.md D1). Do NOT gate on `PATH_EXT` membership — `sql` is already in it (`:36`), so an extension-based allowlist keeps `.sql`, which is the trap. Selection principle: dotfiles commonly written BARE in prose (21 names). **DEVIATION from the exact-name membership this task and design D1 both specified.** Exact-name membership was implemented first, then changed to match the FIRST dot-separated segment, because the priced overshoot turned out to be worse than priced: `.env.example` and `.mcp.json` appear in this repository's own README and two published specs, so exact-name membership withheld precisely the identifiers this kind exists to address, and 8.5's "recoverable by a later list extension" is not a recovery — no list of bare names can contain a name that carries an extension. Segmenting keeps the tightening intact: `.envelope` has `envelope` as its first segment, so `.env` being listed does not admit it, and `.length`/`.sql`/`.HERMES` are unaffected. The delta spec, the rule comment and the tests all state the first-segment rule; design D1's exact-name reasoning is superseded by this note.
- [x] 2.2 Restrict the bare-dotted alternative of `PATH_RE` (`:42`, the `\.[A-Za-z][A-Za-z0-9_.-]{2,40}` branch) to list members, via the rule's `accept` gate or a narrowed pattern — whichever keeps the regex linear. Leave the directory-bearing alternative untouched.
- [x] 2.3 Per design.md open question, leave `.hermes` OUT of the list unless a reviewer objects; note the omission in a one-line comment only if the reason is not obvious from the list itself.
- [x] 2.4 Add the four minimal reproducers to `PROSE_RESEMBLING_ENTITIES` in `apps/server/src/services/entities.test.ts:119` (the zero-tolerance fixture) verbatim: `the .length property is undefined`, `run the .sql migrations by hand`, `spawn returns a .child handle`, `the .HERMES marker is written`. Each must yield `[]`.
- [x] 2.5 Confirm the overshoot guards stay green — `extractor-rules.ts:263` (`.rembric` → `path` `.rembric`) and `:271` (`.claude/settings.local.json`). These are what prove the tightening did not overshoot; if either goes red the narrowing is wrong, not the fixture.
- [x] 2.6 Add a case-sensitivity test: a bare dotted token differing from a listed name only in letter case yields no `path`.

## 3. Budget fairness (defect B)

- [x] 3.1 Rework `extractEntities` (`apps/server/src/services/entities.ts:39-60`) to the max-min fair allocation of design.md D2: each rule collects its deduped candidates up to a ceiling of `MAX_ENTITIES`, then allocate `a_i = min(c_i, q)` for the largest `q` with `Σ min(c_i, q) ≤ MAX_ENTITIES`, remainder tiebroken on `(kind, value)` — never on registry position. `MAX_ENTITIES` stays 250; only the allocation changes.
- [x] 3.2 Removing the early `return out` at `:55` is a consequence of 3.1, not a separate fix — it was never a defect (`:59` is `return out;` immediately after the loop, so no post-loop handling was skipped). Do not leave a comment about it.
- [x] 3.3 Correct the FALSE comment at `extractor-rules.ts:228-231`. The current text asserts order is presentation-only because dedup is keyed `kind:value`; the real reason after 3.1 is that allocation is order-free. One line, stating the why — no banner, no restatement.
- [x] 3.4 Add the first-ever `MAX_ENTITIES` coverage in `entities.test.ts`: the 400-paths-plus-five-kind-tail fixture (400 distinct `node_modules/pkgN/dist/index.js` lines plus a tail carrying one ticket, one errno, one anchored env var, one git ref and one self-hosted hostname). Assert all five kinds are present AND the total is still `<= 250`. Before this change the same input yields 250 entities of kind `path` only.
- [x] 3.5 Add the single-kind test: more distinct paths than the bound, no other identifier, yields exactly `MAX_ENTITIES` `path` entities — not an equal per-rule share. This is what rules out the rejected fixed-share design.
- [x] 3.6 Add the permutation test that makes 3.3's comment true: for a text exercising several kinds, `extractEntities` run against the declared registry order and against a permuted copy yields the same SET of `(kind, value)` pairs. Compare sets, not arrays — array order legitimately follows registry order (design.md D3).
- [x] 3.7 Confirm the linearity scenario (`memory-entities/spec.md:104-107`, 200KB of dot-separated single-char labels well under 50ms) still passes. The allocation must not collect matches without bound.

## 4. Recipe version bump — ONE bump for sections 2 and 3 together

- [x] 4.1 Bump `EXTRACTOR_VERSION` in `apps/server/src/services/entities.ts:25` exactly once, to a name describing the tightening. A and B share the bump deliberately: separate releases would cost two full corpus rebuilds for nothing (design.md D8). Landed as `v7-tracked-dotfiles-fair-budget`: review found the first list overshot (it dropped ten dotfiles this repo tracks), and since the widened list is a different recipe under the same string, the version had to move again or an install that already ran the narrow `v6` would keep its truncated index. One bump per shipped recipe, not per change.
- [x] 4.2 Confirm no migration is added and no `apps/server/src/db/` file changes. `truncateAll` (`entities-repository.ts:482-486`) is already correct and its ordering (scan table first) must not be touched.
- [x] 4.3 Confirm the derived-index invariant holds: `memory_fts`, `memory_vec` and the three entity tables all remain regenerable from `memory` alone, and no `memory` row is written. The extractor recipe is not part of the embedding or FTS input, so neither needs invalidating.

## 5. Verification

- [x] 5.1 `pnpm run typecheck`
- [x] 5.2 `pnpm run lint`
- [x] 5.3 `pnpm test` — including `apps/server/src/test/invariants.test.ts` (data-access confinement, append-only) and `apps/server/src/services/extractor-rules.test.ts` (the registry-wide `examples`/`rejects` sweep).
- [x] 5.4 `pnpm run eval` is NOT required: this change touches neither ranking nor the fusion path, and `memory-entities/spec.md:303-311` keeps entity retrieval out of RRF. Run it only if section 3's rework accidentally touches a retrieval read.
- [x] 5.5 State in the PR that NO measurement harness is needed — all three defects are deterministic and unit-testable — and that the published lexical-noise table (`memory-entities/spec.md:68-81`) is unchanged, because it governs ADMITTING a kind, not tightening an existing pattern. No kind is admitted or retired here.
- [x] 5.6 Do NOT treat `apps/server/src/test/entity-noise/` as the precision gate. Despite the name it measures FTS5 branch noise per identifier class and would not have caught any part of defect A (design.md warning). The gate is `entities.test.ts:119`.

## 6. Docker smoke against pre-existing seeded data (mandatory)

- [x] 6.1 Bring up the dev stack on the PREVIOUS image so the entity index is populated under the old recipe, seed it, and record `adminCountEntities` plus the `.sql` / `.length` / `.child` / `.HERMES` link counts as the before-state. (`pnpm run dev:docker:up` wipes and reseeds — see `docs/docker.md`; `data-dev` needs `chown -R 10001:10001` or the server dies with `SQLITE_CANTOPEN`.)
- [x] 6.2 Upgrade in place to the new build WITHOUT wiping `data-dev`, so the first boot runs `ensureEntityExtractor` against a populated table and an old `entity-state.json`. Assert the boot log carries `entity extractor recipe changed → index reset`.
- [x] 6.3 Assert the drain reaches zero with no operator action: poll `memory.doctor` until the entity backlog is 0. On a seeded corpus of hundreds this should be single-digit seconds (500ms-while-pending pacing, `batchSize` 100).
- [x] 6.4 Re-run `memory.search({entity})` for `.sql`, `.length`, `.child` and `.HERMES` and assert ZERO hits each — the rows must be gone from `memory_entities`, not merely unlinked.
- [x] 6.5 Assert a control set still resolves: `memory.search({entity: '.rembric'})` and a known directory-bearing path both return their memories.
- [x] 6.6 Restart the container once more with no code change and assert NO second reset occurs (`spec.md:291-295`) — the marker must now read `{version: new, pending: false}`. Verified via `docker restart` (a truer restart than a tsx respawn): the recipe-change log line stayed at one occurrence and the marker read `{v6-dotfile-allowlist-fair-budget, pending: false}`. NOTE: the dev CMD runs `seed-dev --reset` on every container start, so each restart reseeds the corpus; the marker file is a `dataDir` file and survives it, which is what makes the check meaningful.
- [x] 6.7 Rollback rehearsal (operator-only, on the dev stack): redeploy the previous image over the same `data-dev` and confirm it boots, resets, and re-links. Rollback is SAFE, not lossless — it re-mints the bogus entities. Record that in the PR rather than claiming a clean rollback. Verified: rolling the source back to `v5` fired a second reset, the drain re-linked, and `.sql` / `.length` / `.child` / `.HERMES` were re-minted. Rolling forward again cleared them. The `v5` binary writes a marker with no `pending` field, which the new `readMarker` reads as settled (D4).

## 7. Production verification after deploy (operator-only)

- [ ] 7.1 Confirm the boot log shows exactly one recipe-change reset.
- [ ] 7.2 Confirm `memory.doctor`'s entity backlog reaches zero, and the reported link-count delta (`spec.md:245`) is not warning.
- [ ] 7.3 Re-run `memory.search({entity})` for `.sql`, `.length`, `.child` and `.HERMES` against the production corpus and confirm zero hits. This is the measurement this change is accountable for: four values, zero rows each.
- [ ] 7.4 Spot-check that `$MRR`-shaped and `#4`-shaped rows are STILL present. They are accepted documented ambiguities (design.md D6, D7); their disappearance would mean the tightening overshot into `env_var` or `ticket`.

## 8. Deferred and explicitly rejected — do not silently lose these

- [x] 8.1 REJECTED: changing `MAX_ENTITIES`'s value. There is no measurement justifying a different number, and raising it does not fix starvation — it moves the threshold.
- [x] 8.2 REJECTED: a digit floor on `ticket` `#NN`. Would drop real single-digit issue references; `#36` is already published as legitimate and priced at 50% noise (`spec.md:73`).
- [x] 8.3 REJECTED: requiring an underscore in `env_var` names. Kills `$MRR` but also `$PATH`, `$HOME`, `$PWD`, `$SHELL`, `$EDITOR`, recoverable only via a closed name list.
- [x] 8.4 REJECTED: a DB-resident recipe marker. Needs a new table plus a migration — there is no kv/settings/meta table in `apps/server/src/db/schema/` — for a guarantee a second file write provides.
- [x] 8.5 DEFERRED: adding `.hermes` to the dotfile-name list, and any other list extension. Cheap and lossless later (one version bump, one rebuild); left out now to keep the list minimal.
- [x] 8.6 DEFERRED: an extractor-precision measurement harness. Not needed for deterministic patterns; if a future kind needs one, it belongs beside `entity-noise/` with a clear name distinguishing extractor precision from lexical noise.
