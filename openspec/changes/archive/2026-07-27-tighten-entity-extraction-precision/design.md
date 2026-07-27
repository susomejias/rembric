## Context

The deterministic entity index shipped in `archive/2026-07-25-add-entity-index`. Its design anticipated exactly this change: Decision 2 chose precision over recall, and the Risks section (`:47`) says "if a rule turns out too loose, tighten it and rebuild, since nothing is lost. This is the strongest argument for shipping the rebuild with the feature." Defect A is the anticipated case, and the archive prescribes tighten-and-rebuild. This change is therefore a **tightening, not a redesign** — direct precedent, not a new judgement call.

Current state, all three verified against the code on disk and reproduced with the real extractor:

- `PATH_RE` (`extractor-rules.ts:42`) has two alternatives. The first requires at least one `/` plus a terminal extension from `PATH_EXT`, and is sound. The second, `\.[A-Za-z][A-Za-z0-9_.-]{2,40}`, matches any bare dotted token of 4+ characters and is the entire defect. Its only legitimate job in the current fixtures is `.rembric` (`:263`) — `.claude/settings.local.json` (`:271`) goes through the _first_ alternative, since it has a `/` and a terminal `json`.
- `extractEntities` (`entities.ts:39-60`) enforces `MAX_ENTITIES = 250` with `if (out.length >= MAX_ENTITIES) return out;` inside the inner loop, so the budget is consumed strictly in registry order across 15 rules covering 13 kinds.
- `ensureEntityExtractor` (`entity-state.ts:50-66`) writes the marker, then wipes. Both mitigations `spec.md:241` prescribes are in place; the uncovered case is transaction rollback.

Constraints inherited from the repo, all binding on this change:

- **Derived-index invariant.** `memory_fts`, `memory_vec` and the three entity tables must stay regenerable from `memory` alone. That is what licenses the corpus-wide reset as the remediation mechanism.
- **All SQL under `apps/server/src/db/`.** `truncateAll` (`entities-repository.ts:482-486`) already exists and needs no change.
- **Extraction must stay linear** in input length (`spec.md:87`, under 50ms at 200KB) — a quadratic label group once blocked the event loop for 19 seconds on one save. Any budget rework must not collect matches without bound.
- Comments stay terse. The registry-order comment is being _corrected_, not expanded.

## Goals / Non-Goals

**Goals:**

- Stop the extractor producing `path` entities from prose, with the four production reproducers as permanent zero-tolerance fixtures.
- Make the per-memory entity budget fair across kinds, and make the registry-order comment true rather than deleting it.
- Make a rolled-back wipe leave the marker _not_ claiming the new recipe, so the reset re-fires.
- Get all of it to existing installations with one `EXTRACTOR_VERSION` bump and zero operator action.

**Non-Goals:**

- No change to `MAX_ENTITIES`'s value (250). Only its allocation.
- No new entity kind, no removed kind, no change to the published lexical-noise table (`spec.md:68-81`) — that table governs _admitting_ a kind, and none is being admitted or retired.
- No measurement harness. All three defects are deterministic and unit-testable; a harness would add ceremony without adding evidence.
- No migration, no schema change, no new MCP tool, no dashboard change, no plugin-tree change.
- Not fixing `ticket: '#4'` or `env_var: 'MRR'`. Both are accepted and documented (D6, D7).

## Decisions

**D1 — A bare dotted token is a path only by closed dotfile-NAME membership, never by extension.**
The list is of dotfile _names_ (`.rembric`, `.env`, `.gitignore`, …), declared in the rule registry beside `PATH_EXT` so it is inspectable, and matched **case-sensitively**: POSIX paths are case-sensitive, the path normalizer deliberately does not lowercase, and case-insensitive membership would re-admit `.HERMES` the moment `.hermes` entered the list. Rejected alternative: an extension-based allowlist — "admit `.X` when `X` is in `PATH_EXT`". It is a trap, not a solution: `sql` is already in `PATH_EXT` (`:36`), so it would keep `.sql`, the second of the four reproducers. Also rejected: dropping the bare-dotted alternative entirely, which is cleaner but loses `.rembric` — the one bare dotfile Rembric's own protocol depends on and which appears in real memories. Also rejected: a denylist of English words, which `spec.md:13` explicitly forbids as an admission mechanism.

**D2 — The budget becomes a max-min fair (water-filling) allocation with a per-rule collection ceiling.**
Each rule collects its normalized, deduped candidates up to a ceiling of `MAX_ENTITIES` (so nothing is collected without bound and linearity is preserved); then the budget is allocated as `a_i = min(c_i, q)` for the largest integer `q` with `Σ min(c_i, q) ≤ MAX_ENTITIES`, remainder distributed by a tiebreak on `(kind, value)` rather than registry position. Two properties fall out: a text mentioning one kind only still gets up to 250 of it (no recall regression on the common case), and a text with 400 paths plus five other kinds gets all five kinds. Rejected: a fixed equal per-rule share (`ceil(250/15) = 17`), which is simpler but caps a genuine 300-path dump at 17 paths — trading a real regression for a hypothetical one. Rejected: collect everything then truncate, which is order-free but unbounded in memory on a 200KB dump. Rejected: raising `MAX_ENTITIES`, which does not fix starvation — it only moves the threshold, and there is no measurement justifying a different number.

**D3 — Registry-order invariance is asserted on the produced SET, not the produced array.**
Array order legitimately follows registry order (that is what "presentation-only" means). What must not vary is membership. The permutation test therefore compares the set of `kind:value` pairs, which is the precise claim the corrected comment makes. Rejected: sorting the output array to make array equality assertable — it would change the entities projection's presentation order for no behavioural gain.

**D4 — The recipe marker becomes two-phase on disk, not DB-resident.**
`{extractorVersion, pending: true}` is written first; `resetEntityIndex` runs; the marker is rewritten `{extractorVersion, pending: false}`. `readMarker` treats a marker whose `pending` is `true` as an identity mismatch, so the reset re-fires on the next boot. A marker with **no** `pending` field is treated as complete — markers written by 0.24.x predate the protocol, and treating absence as pending would make an ordinary deployment rebuild the index, violating `spec.md:291-295`. This is behaviourally identical for _this_ deploy (the version differs anyway) and correct for every later one.

Two properties from `fc6e2ff` must survive, and do: marker-before-wipe ordering (the first write still precedes the wipe, so a full or read-only `dataDir` throws _before_ anything is destroyed) and the `try` at `bootstrap.ts:204` (an unwritable `dataDir` degrades to "re-check next boot" rather than "no boot until disk frees"). If the third write — the flip to `pending: false` — is the one that fails, the index is already wiped and the marker still says pending, so the next boot resets again idempotently and the drain re-links regardless; `entityBackfillTick(true)` sits outside the `try`, so the drain still runs in that boot. Rejected: a DB-resident marker in a kv/settings table. There is no such table anywhere in `apps/server/src/db/schema/`, so it would mean a new table plus a migration for a guarantee a second `writeFileSync` already provides — disproportionate.

**D5 — Reading of `spec.md:259-262`, so the archiver does not have to re-derive it.**
The scenario's second clause, "the drain SHALL still see the corpus as unscanned", cannot be satisfied _within_ a failed attempt: rollback restores the scan rows by definition, and the wipe is required to be atomic by the clause immediately above it. It is satisfied **across the retry**: after a rolled-back wipe nothing claims the new recipe, so the next `ensureEntityExtractor` resets, and only then is the corpus unscanned with a non-zero backlog. That is the guarantee the test asserts, and it is why no requirement text needs modifying for defect C.

**D6 — `ticket: '#4'` and `'#5'` are accepted, documented ambiguities.**
They arise from titles like "Opportunity-scan #4". `spec.md:73` already _publishes_ `#36` as a legitimate ticket form and already measures the form at 50% noise, so this is a known, priced tradeoff rather than a discovery. A minimum-digit floor would drop real single-digit issue references, which are common in young repositories. Recorded in the delta alongside `git_ref`'s `accede1` (`extractor-rules.ts:366-367`) and `systemd_unit`'s `user.service` (`:400-401`), so the three sit in one list.

**D7 — For `env_var`, the anchor requirement dominates the anti-prose requirement, and the currency-sigil false positive is accepted.**
The spec contradicts itself today: `:15` mandates that a `$`-anchored token is typed `env_var`, `:34` forbids extracting prose that merely resembles an entity, and `$MRR` in "grew $MRR by 12%" satisfies both. The delta resolves it explicitly in `env_var`'s favour, because the anchor is the closed-syntax gate `:13` demands and the alternative reintroduces exactly the untypeable-SCREAMING_SNAKE problem `:15` was written to remove. Rejected: requiring an underscore in the name. It kills `$MRR`, but also `$PATH`, `$HOME`, `$PWD`, `$SHELL`and`$EDITOR` — recovering those needs a closed name list, i.e. real ongoing maintenance surface, to remove one bogus row.

**D8 — One `EXTRACTOR_VERSION` bump for all three, and the marker fix ordered first.**
The bump is the entire remediation mechanism for A and B, so the reset path has to be sound before it fires; `tasks.md` therefore lands C first. Landing all three together gets this right automatically — the corrected reset path and the new recipe reach the operator in the same deploy. Rejected: separate releases, which would cost two full corpus rebuilds and open a window where a rolled-back wipe silently strands the corpus under the old recipe.

**D9 — `return out` at `entities.ts:55` is not a defect, and is worth naming as a latent hazard.**
`entities.ts:59` is `return out;` immediately after the loop, so there is no post-loop handling for the early `return` to skip. It is not a bug today. It is a hazard only in the sense that any future post-loop step (sorting, a final dedup pass, telemetry) would be silently skipped for capped inputs. The allocation rework in D2 removes the early return anyway, which closes the hazard as a side effect rather than as its own fix.

## Risks / Trade-offs

- **[Risk] The dotfile-name allowlist overshoots and drops real bare dotfiles.** Any bare dotfile not on the list stops being extracted, and the list can only be extended by another version bump and rebuild → Mitigation: the regression guard is the other half of the evidence gate — `extractor-rules.ts:263` (`.rembric`) and `:271` (`.claude/settings.local.json`) must stay green, and the second of those proves the slash-bearing alternative was not disturbed. The cost of overshooting is a missing entity, which the archive's own precision-over-recall decision (`design.md:25`) prices as strictly cheaper than a false one, and which a later list extension recovers in full because nothing is lost.
- **[Risk] The budget rework changes extraction output for large memories in ways no test currently pins.** `MAX_ENTITIES` has zero coverage today → Mitigation: the 400-paths-plus-five-kind-tail fixture, the permutation test, and the existing linearity scenario (`spec.md:104-107`, 200KB under 50ms) run together; the first is the behaviour, the second is the invariant, the third is the cost.
- **[Risk] The reset is corpus-wide, so entity retrieval is incomplete until the drain finishes.** `spec.md:283` requires that window be bounded → Mitigation: the drain already self-paces at 500ms while pending / 30s idle with an hourly safety net and `batchSize` 100, and `bootstrap.ts` fires a forced tick at boot. For a corpus of hundreds this is single-digit seconds. Empty results during the window already carry the draining signal (`spec.md:264-269`), so an agent is not told the identifier is unknown.
- **[Trade-off] `$MRR` and `#4` stay in the index** → Accepted because D7 and D6 each price the fix as worse than the defect: a closed env-var name list, or losing real single-digit tickets.
- **[Trade-off] Rollback to 0.24.13 re-mints the bogus entities** → Accepted because rollback is safe (the older binary's version mismatch fires its own reset from `memory`, so nothing is corrupt) and the defect it restores is the one being shipped away from. There is nothing to make rollback lossless here that is not just "do not roll back".
- **[Warning worth recording] `apps/server/src/test/entity-noise/` is NOT an extractor-precision gate, despite the name.** It measures how noisy the FTS5 lexical branch is per identifier class, and would not have caught any part of defect A. The real gate is the zero-tolerance prose corpus at `entities.test.ts:119`. A future contributor who "checks the noise tests are green" has verified nothing about extractor precision.

## Migration Plan

No migration. No schema change, no `ALTER TABLE`, no table rebuild, no FK dance. `entity-state.json` is a `dataDir` file, not a table.

Deploy path on an existing installation:

1. First boot after upgrade: `ensureEntityExtractor` reads `entity-state.json`, sees the old `EXTRACTOR_VERSION`, writes `{version: new, pending: true}`, runs `resetEntityIndex` in one transaction, flips to `pending: false`.
2. `truncateAll` **deletes** rows from all three entity tables in the mandated order (`memory_entity_scan` first) — so the bogus entities are gone from `memory_entities`, not merely unlinked. Re-linking mints only what the new recipe extracts, so `.sql` / `.length` / `.child` / `.HERMES` cannot reappear.
3. `bootstrap.ts` runs a forced `entityBackfillTick(true)`, then `scheduleEntityBackfill` self-paces (500ms while pending, 30s idle, hourly safety net, `batchSize` 100). Zero operator action; single-digit seconds for a corpus of hundreds.
4. No `memory` row is read for anything but `title + content`, and none is written. `memory_fts` and `memory_vec` are untouched and need no invalidation — the extractor recipe is not part of the embedding or FTS input.

Rollback: redeploy 0.24.13. Its `EXTRACTOR_VERSION` mismatches the marker, so it resets and re-links under the old recipe — safe, and it restores the defects. The `pending` field it does not understand is ignored by its `readMarker`, which reads only `extractorVersion`, so the older binary does not choke on the newer marker.

## Open Questions

- **Whether `.hermes` belongs in the dotfile-name list at all.** It is a real directory (`${HERMES_HOME:-~/.hermes}`), but Rembric's own tree carries `.hermes-plugin`, not `.hermes`, and admitting it is what makes D1's case-sensitivity decision load-bearing rather than merely correct. Default if nobody objects: **leave it out**, and let the slash-bearing alternative handle `.hermes/...` where a real path appears. Adding it later is a version bump and a rebuild, which is cheap and lossless.
- **Whether the remainder of the water-filling allocation should be distributed at all.** Dropping the remainder wastes at most 12 of 250 slots and removes the last tiebreak from the code. Default: **distribute it**, tiebroken on `(kind, value)`, because "the bound is 250" is easier to state in the spec than "the bound is 250 minus a rounding artifact".
