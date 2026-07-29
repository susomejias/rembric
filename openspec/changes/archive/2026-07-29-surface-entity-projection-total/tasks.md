## 1. The field

- [x] 1.1 Re-verify on disk before editing: `entitiesTruncated` appears only in
      `mcp/memory-tools.ts` (schema declarations plus three emit sites), and
      `findEntitiesForMemory`/`findEntitiesForMemories` carry no `LIMIT`. If either premise is
      false the change is void — the count would no longer be free.
- [x] 1.2 Replace `entitiesTruncated: z.boolean().optional()` with `entitiesTotal: z.number()`
      in both output schemas. Not optional: the requirement says present whenever `entities` is.
- [x] 1.3 At all three emit sites, emit `entitiesTotal: ents.length` unconditionally alongside
      the sliced `entities`. Take the count from the SAME array the slice is applied to, at the
      slice site, so the two cannot drift.
- [x] 1.4 Confirm exactly three emit sites changed and no fourth exists. Grep for
      `ENTITIES_PROJECTION_CAP` and check every use is accounted for.

## 2. Tests — the field had NO coverage before this change

- [x] 2.1 `memory-tools.test.ts`: a memory linked to more than `ENTITIES_PROJECTION_CAP`
      entities returns exactly the cap in `entities` and the larger true count in
      `entitiesTotal`, on all three surfaces (search row, batch get, single get).
- [x] 2.2 An untruncated memory carries `entitiesTotal` equal to `entities.length`.
- [x] 2.3 A memory with no entities carries `entitiesTotal: 0` and an empty `entities`.
- [x] 2.4 No response field reports entity truncation as a boolean, and `entitiesTruncated` is
      absent from the payload.
- [x] 2.5 Scope: entities linked to a same-named value in another project are not counted.
- [x] 2.6 **Mutation check, denominators reported.** Assert the passing count first. Then (a)
      change the emit to `entities.length` after the slice and confirm 2.1 fails; (b) restore
      `entitiesTruncated` and confirm 2.4 fails. Record `N failed | M passed (T)` and the
      messages. A test that passes under (a) is asserting nothing — that mutation is the
      `predecessorCount` defect this change exists to avoid.

## 3. Spec

- [x] 3.1 `mcp-api` delta: modify "Memory-returning reads MUST expose the entities a memory is
      about" so the bound's effect is a count, not an indication, and replace the "truncation
      SHALL be indicated" scenario. Preserve the "A returned memory carries its entities"
      scenario verbatim.
- [x] 3.2 `memory` delta: `ENTITIES_PROJECTION_CAP`'s bullet in "Retrieval and lifecycle
      constants MUST be named and bounded in one place" currently says "whose exhaustion is
      reported to the caller". Change to the pre-bound count. Preserve all seven published
      scenarios of that requirement verbatim — it was modified twice today already.
- [x] 3.3 Confirm no `memory-entities` delta is needed: grep it for `entities[]`,
      `entitiesTruncated` and `projection`. The issue predicted a delta there; if the grep
      finds nothing the prediction was wrong and no delta should be invented to match it.
- [x] 3.4 Grep `openspec/specs/` for `entitiesTruncated` and `truncation SHALL be indicated`
      and confirm the delta removes every published occurrence, not one of several.
- [x] 3.5 Confirm the `relationsTotal` requirement's no-companion-boolean clause is not
      contradicted by anything this change publishes.

## 4. Verification

- [x] 4.1 `pnpm run typecheck`
- [x] 4.2 `pnpm run lint`
- [x] 4.3 `pnpm test` — record baseline and delta; the delta is the tests added in §2.
- [x] 4.4 `pnpm run eval` — non-regression. No ranking or retrieval path changes, so movement
      is a stop condition.
- [x] 4.5 `pnpm run check:spec-provenance`
- [x] 4.6 `openspec validate surface-entity-projection-total --strict`
- [x] 4.7 `git ls-files apps/plugin/` untouched — no input schema changes, so any plugin diff
      is a mistake.
- [x] 4.8 `apps/server/src/db/` untouched — no SQL, no repository, no migration.
- [x] 4.9 Confirm the `memory.get`/`memory.search` descriptions do not promise a boolean, and
      name no argument that raises the returned entity count (design.md D3).

## 5. Docker smoke

- [ ] 5.1 Operator-run. Save a memory whose content names more than 10 distinct identifiers,
      then read it back over `/mcp/<slug>` with both `memory.get` and `memory.search`, and
      confirm `entitiesTotal` exceeds `entities.length` on both. Assert the non-empty case: a
      probe where every `entitiesTotal` is 0 has verified nothing.

## 6. Deferred

- [ ] 6.1 **Deferred: an ordering guarantee for `entities[]`** (design.md D2). This change
      makes the truncation's extent visible without claiming the retained entities are the
      right ones. Seed the follow-up with the distribution 6.2 asks for.
- [ ] 6.2 **Deferred: is `ENTITIES_PROJECTION_CAP = 10` right?** Unanswerable before this
      change and answerable after it. Record the distribution of `entitiesTotal` over real
      reads before proposing a new bound.

## Apply notes (2026-07-29)

### 2.6 — mutation check

Baseline asserted first: **71 passed** in `memory-tools.test.ts`.

| mutation                                               | result                     | failing assertion                                         |
| ------------------------------------------------------ | -------------------------- | --------------------------------------------------------- |
| count taken AFTER the slice (`ents.slice(...).length`) | 1 failed \| 70 passed (71) | `single: expected 10 to be 27`                            |
| `entitiesTruncated` restored beside the total          | 1 failed \| 70 passed (71) | `expected { … } to not have property "entitiesTruncated"` |
| restored                                               | 71 passed                  | —                                                         |

The first mutation is the `predecessorCount` defect this change exists to avoid — a "total" that
restates the returned length. It fails on all three surfaces, not just one.

A first draft of the no-boolean test asserted `JSON.stringify(payload)` does not contain
`Truncated`, which failed against the **legitimate** `truncated`/`headTruncated` fields
describing the predecessor chain. Narrowed to booleans whose key names an entity, so it pins
what it claims to.

### 3.3 — the issue's prediction was wrong

Issue #291 states the change "needs an OpenSpec change against `memory-entities` + `mcp-api`".
Grep finds nothing about the `entities[]` projection, `entitiesTruncated` or the projection cap
anywhere in `memory-entities/spec.md` — that capability governs extraction, scoping and
exact-address retrieval, not the read projection. No `memory-entities` delta was invented to
match the prediction. The second capability affected is `memory`, which owns the constant list.

### 3.1 — the archiver refused a deliberate scenario drop, and was right to

The delta first RETITLED "The entity list is bounded" to "…and its true size reported", because
its published THEN clause (`the truncation SHALL be indicated`) is the exact thing this change
retires. `openspec archive` aborted: _"current spec contains scenario(s) not present in the
modified block"_. The header is the identity, so a retitle reads as a deletion — the same
mechanism that halted the graph-view archive earlier today, this time catching an intentional
change rather than an accidental one.

Resolved by keeping the published header and rewriting only its THEN clause. Every published
scenario of both requirements is now preserved by title: 2 of 2 in `mcp-api` (plus 5 added),
7 of 7 in `memory`.

### 4.3 — test count

1887 → **1891**, +4, matching the four tests added in §2. `pnpm test` at the repo root.

### Not done

- **5.1 (Docker smoke) NOT run.** `dev:docker:up` wipes `data-dev`, which holds the 2055-row
  corpus kept for device testing. The three surfaces are covered at the handler level against a
  real migrated SQLite file, but not over a live `/mcp/<slug>` transport.
- **6.1, 6.2 not filed** as follow-up changes; the reasoning is in `design.md` D2 and the open
  question.
