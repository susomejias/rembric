## 1. Re-verify the preconditions on disk

- [ ] 1.1 Confirm `findEntitiesForMemory` and `findEntitiesForMemories` in `apps/server/src/db/repositories/entities-repository.ts` both still carry `.orderBy(memoryEntities.kind, memoryEntities.value)`, and record the line numbers as found. If either has lost it, stop — the interleave's input is no longer deterministic and D2 must be revisited before any code lands.
- [ ] 1.2 Confirm exactly three `ents.slice(0, ENTITIES_PROJECTION_CAP)` sites exist in `apps/server/src/mcp/memory-tools.ts` and that each pairs with `entitiesTotal: ents.length`. Record the line numbers. A fourth site means a surface was added since propose and must be included.
- [ ] 1.3 Confirm `memory.context` still projects no `entities[]` (design Open question 3). If it does now, its ordering is in scope and the spec's "all three surfaces" scenario is wrong.
- [ ] 1.4 Confirm `ENTITY_KINDS` is still 12 kinds and `ENTITIES_PROJECTION_CAP` is still 10, so D6's residual (distinct kinds > bound) is still reachable only at 11 of 12.

## 2. Reproduce the measurement before changing anything

- [ ] 2.1 Re-run the propose-time instrument: the shipped `extractEntities` over this repo's last 400 commit bodies (284 with a non-empty body). Reproduce `entities/doc p50=1 p90=3 p99=8 max=23` and `bound binds on 2/284`. Write the figures to `measurements.md` in this change folder with the commit range used, so the numbers carry their denominator and are re-derivable.
- [ ] 2.2 In the same script, record for each binding document the entities dropped under `(kind, value)` and under fair share. Reproduce `2/2 documents lose an entire kind` today and `0/2` under fair share. If either figure has moved, the proposal's evidence has moved and D1 must be re-argued before the code lands.
- [ ] 2.3 Record in `measurements.md` that the resident dev corpus was rejected as the instrument, with its numbers (2055 memories, content length p50 71, max entity links per memory 2, 31 of 32 entities `path`, bound binds on 0 rows) so the rejection is evidence rather than an omission.
- [ ] 2.4 Do NOT commit the measurement script into `apps/server/src/`. It is propose/apply evidence, not a shipped harness; `measurements.md` carries the figures and the recipe.

## 3. Implement

- [ ] 3.1 Add the projection helper to `apps/server/src/services/entities.ts`, beside the existing max-min fair-share budget allocator: it takes the ordered entity views plus the bound and returns `{ entities, entitiesTotal }` (D5). Round-robin over per-kind groups, kinds visited in ascending kind name, within-kind order preserved from the input.
- [ ] 3.2 Replace all three `memory-tools.ts` sites (search, batch `get`, single `get`) with the helper. `ENTITIES_PROJECTION_CAP` keeps its name, value and location; no `slice` and no `ents.length` remains at any of the three sites.
- [ ] 3.3 Extend the doc comments on `findEntitiesForMemory` / `findEntitiesForMemories` to state that the `ORDER BY` is now the interleave's stable input, not only the subset's stability (D2). One line each; no banner, no restatement of the query.
- [ ] 3.4 Verify no repository, schema, migration or `apps/plugin/` file is touched: `git status --short` after implementation shows changes only under `apps/server/src/{services,mcp}/` plus tests plus this change folder.

## 4. Test

- [ ] 4.1 Unit-test the helper in `apps/server/src/services/entities.test.ts`: the 21-path + ticket + url + env_var case from the spec (every kind present, surplus to paths, total 24); a list under the bound (returned whole, total equals length); an empty list (empty plus 0); a single-kind list (plain prefix, no interleave artefact); and the D6 residual (distinct kinds > bound, kind-name order decides, total still complete).
- [ ] 4.2 Extend the existing `entitiesTotal` surface loop in `apps/server/src/mcp/memory-tools.test.ts:353` so it asserts the projected ORDER, not only the count, and asserts all three surfaces return an identical list for the same memory.
- [ ] 4.3 Add a repeatability assertion: the same memory read twice with no intervening write returns the identical array, on a memory whose entity count exceeds the bound.
- [ ] 4.4 Add a `fields: ['entities']` test asserting order, bound and `entitiesTotal` all match an unprojected read — the path that regressed in `a01d051` (D5).
- [ ] 4.5 Mutation check A: replace the helper with the old `slice` at all three sites, run the full suite, and record which tests fail. Zero failures means the new tests do not pin the ordering and are not yet done. Restore and confirm green.
- [ ] 4.6 Mutation check B: remove `.orderBy(...)` from both repository methods, run the full suite, and record which tests fail. Zero failures means the `ORDER BY`'s new load-bearing role (D2) is unprotected — add the assertion that catches it. Restore and confirm green.

## 5. Verify

- [ ] 5.1 `pnpm run typecheck`
- [ ] 5.2 `pnpm run lint`
- [ ] 5.3 `pnpm test` — full suite green, including `apps/server/src/test/invariants.test.ts` (data-access confinement must still pass: the interleave is in a service, so no new SQL appears outside `db/`).
- [ ] 5.4 `pnpm run eval` — non-regression only. Record the metrics as unchanged; per D7 the result is NOT evidence for this change, and a moved metric means something outside the projection was touched and must be explained.

## 6. Smoke against real Docker with pre-existing seeded data

- [ ] 6.1 Bring up the dev stack (`pnpm run dev:docker:up`, `chown -R 10001:10001 data-dev` first if it fails with `SQLITE_CANTOPEN`) and confirm boot logs show no migration ran — this change adds none.
- [ ] 6.2 Against the seeded corpus, call `memory.search` and a batch `memory.get` and confirm every returned row carries `entities[]` and `entitiesTotal`, with `entitiesTotal` matching the pre-upgrade value for the same ids. The seed corpus has at most 2 links per memory, so this proves no regression on the non-binding path — it does NOT exercise the interleave.
- [ ] 6.3 Save one memory whose content carries more than 10 identifiers across at least three kinds (paths plus a `#nnn` ticket plus a URL), wait for the entity scan to drain, then read it back through all three surfaces. Confirm the ticket and the URL are present, `entitiesTotal` exceeds 10, and the three surfaces agree. This is the only step that exercises the change end to end.
- [ ] 6.4 Confirm `/dashboard/entities` still renders and its per-entity `linkCount` figures are unchanged — the dashboard reads the same links through a different aggregate and must be unaffected.
- [ ] 6.5 Tear the stack down and confirm no stray container or volume remains.

## 7. Close out

- [ ] 7.1 Confirm the two delta spec files still preserve every published scenario title verbatim (`openspec archive` matches scenarios by header and refuses to drop one): the seven in `mcp-api` and the seven in `memory`'s constants requirement.
- [ ] 7.2 `npx openspec validate order-entity-projection --strict` passes.
- [ ] 7.3 File the deferred items so they are not lost: rarity ordering with D3's stated trigger (0.7% binding rate to beat, plus the 1k/20k/50k link-count cost measurement it would need), and the per-installation binding-rate figure on `/dashboard/entities` as a `dashboard` change (D4).
- [ ] 7.4 Record explicitly that `ENTITIES_PROJECTION_CAP` was left at 10 and why (p99 = 8), so a later reader does not read the untouched constant as an unexamined one.
- [ ] 7.5 Commit with Conventional Commits, no `--no-verify`. The projection change and the spec delta belong in the same commit; the measurement figures land with it.
