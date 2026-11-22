# Tasks

## 1. Tests first

- [x] 1.1 `nudge-fixtures.json` gains `postCompactTemplate` and `postCompactCoreTemplate`. `nudge-fixtures.test.ts` pins `post-compact.sh` output with an id (rendered template) and without one (symbolic block, no placeholder, no empty id), the rendered byte cap, the two-call difference, and the core template, renderer and Python template against the fixture.
- [x] 1.2 RED observed: 4 failures (bash output, core template, renderer, Python template), each on the intended assertion.
- [x] 1.3 `plugin.test.ts` pins the opencode string rendered with `sessionID`, and the symbolic fallback without it. `test_post_compact_directive.py` pins the Hermes hint with and without an id, and its negative assertions move to a marker that does not depend on the rendering.

## 2. Implementation

- [x] 2.1 `rembric-plugin-core.mjs`: `POST_COMPACT_NUDGE_CORE_TEMPLATE` and `renderPostCompactNudgeCore`, declared in the `.d.mts`.
- [x] 2.2 `post-compact.sh`: render the id when stdin carries one, portable to bash 3.2.
- [x] 2.3 opencode compacting handler and Hermes `prefetch()` render through the template.
- [x] 2.4 The one-source grep in `invariants.test.ts` recognises the renderer.

## 3. Verification

- [x] 3.1 Mutation-checked with `scripts/mutate.mjs`: the bash guard (forced off, forced on), each bash substitution, the core renderer's guard (forced on, forced off) and its value, and the opencode call site. All 8 were caught. The Hermes guard was mutated by hand (forced off, forced on), and both were caught.
- [x] 3.2 Targeted suites green: `nudge-fixtures`, opencode `plugin.test.ts`, `file-recall`, the invariant, and Hermes `test_post_compact_directive.py`.
- [x] 3.3 Real Claude Code e2e with auto-compaction, interleaved A/B, recorded in `design.md`.
- [x] 3.4 `pnpm run check:delta-freshness`, `check:delta-sections` and `check:spec-crossrefs` are ok, with no advisory on this change. `openspec validate --strict` was not run locally because the CLI is not installed in this environment.
