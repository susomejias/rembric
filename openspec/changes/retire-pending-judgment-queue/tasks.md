## 1. Switch

- [x] 1.1 Read `JUDGMENT_QUEUE_ENABLED` in `apps/web/src/lib/services.ts` (`envInt`, default `0`, bounds `0..1`) and pass it to `postSave.candidates` as a `persist` option.
- [x] 1.2 `packages/core/src/services/save-curation.ts`: with `persist` false, build `candidates[]` from the detected pairs without calling `relations.createPending`; carry `sourceId` and, for the high band, `converge: true`; leave `convergeWith` empty. With `persist` true the code path is the present one.
- [x] 1.3 RED first, one test per rule in `memory/spec.md` and one proving the `persist: true` path is byte-identical to the baseline response for the same save.

## 2. MCP surface

- [x] 2.1 `packages/mcp/src/memory-tools.ts` and `observability-tools.ts`: `judgmentId` optional on `candidate`; add optional `sourceId` and `converge`; `judgmentRequired` false and `convergeWith` empty when the queue is disabled, for `memory.save`, `memory.capture_passive` and confirmed `memory.merge`.
- [x] 2.2 `packages/mcp/src/instructions.ts`: a queue-disabled variant that names `memory.compare` for `supersedes` and `conflicts_with`; keep every variant at 1500 characters or fewer; keep the present text for the enabled setting. Update `instructions.test.ts` to pin both.
- [x] 2.3 Tool descriptions in `packages/mcp/src/server.ts` and the tool files for `memory.save`, `memory.capture_passive`, `memory.merge`, `memory.compare`, `memory.judge_batch`, `memory.context`, per the guidance requirement.
- [x] 2.4 Refresh the tool-surface baseline that `apps/web/src/test/mcp-tool-surface.test.ts` compares against.

## 3. Hook route

- [x] 3.1 `apps/web/src/app/api/[slug]/sessions/[id]/learnings/route.ts`: no code change expected beyond the shared path; add the two route scenarios as tests.

## 4. Docs and plugin text

- [x] 4.1 `docs/relations.md`, `docs/agents.md`, `docs/troubleshooting.md`, `README.md`: describe the switch, the two actions, and that pending judgments are legacy while it is `0`.
- [x] 4.2 `apps/plugin/.hermes-plugin/__init__.py`: the static prompt block teaches the queue-disabled flow (Hermes never receives the server's instructions). `commands/context.md` and `apps/plugin/README.md` stay as they are: the tool and the legacy rows remain. The skill's dev-stack e2e was not run for this string-only change; the Hermes unit suite and the server parity test cover it.
- [x] 4.3 `CLAUDE.md`: reword the "Fresh-context judgment" invariant to describe both settings.

## 5. Verification before release

- [x] 5.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.
- [x] 5.2 Mutation check (`scripts/mutate.mjs`) on the `persist` guard in `save-curation.ts`: the tests naming it go red when the guard is inverted.
- [x] 5.3 Differential check against the base commit: with `JUDGMENT_QUEUE_ENABLED=1`, the responses of `memory.save`, `memory.capture_passive`, `memory.merge` and the learnings route for the same inputs are identical to the base.
- [ ] 5.4 `pnpm run check:delta-sections`, `check:delta-freshness`, `check:spec-crossrefs`, and `openspec validate retire-pending-judgment-queue --strict`.
- [ ] 5.5 `rembric-smoke-tests` against the local dev server on both settings.

## 6. Production validation (after release)

- [ ] 6.1 Take a backup before upgrading production. Record the upgrade date here.
- [ ] 6.2 Day 7: take a backup and compute V1 and V3–V6 from `design.md` per project and in total. Record the figures here.
- [ ] 6.3 Decide per the gate in `design.md`: open `remove-judgment-queue-surfaces`, or set `JUDGMENT_QUEUE_ENABLED=1` and record why.
- [ ] 6.4 Do not archive this change before 6.3 is recorded.

## Evidence (2026-11-22)

- RED before each change: 4 save/merge tests, 1 capture test, 7 guidance tests, the route's unset case; the 2 preservation tests (topic_key supersession, a pending row surviving the switch) passed before and after.
- `pnpm test`: db 376, mcp 557, core 1651, web 2368 passed. The two Pi instruction cases then failed because the server default changed; after pointing them at the queue-disabled instructions, `apps/plugin/.pi-plugin/plugin.test.ts` 90 passed. Hermes `python3 -m unittest discover -s tests`: 205 OK.
- `pnpm run typecheck` and `pnpm run lint`: clean. Prettier clean on every changed file.
- Mutation (`scripts/mutate.mjs`): `persist ?? true` → `true` caught by 4, → `false` caught by 2; dropping `sourceId` caught by 3; dropping `converge` caught by 2; `judgmentRequired` back to `length > 0` caught; env default `0` → `1` and `persist: false` both caught by the route tests.
- Differential: a probe saving four memories and one capture through an in-memory MCP client, run on the base commit and on this change with `persist: true`, produced byte-identical instructions, tool descriptions and responses after normalising ids and timestamps. Output schemas differ by design (optional `judgmentId`, new optional `sourceId` and `converge`), recorded in `mcp-tool-surface.test.ts`. `memory.merge` and the learnings route were not in the probe; with the queue enabled they are covered by the unchanged merge band test and the route's `JUDGMENT_QUEUE_ENABLED=1` case.
- 5.5 not run: no smoke against a local dev server yet.
- 5.4: the three repo gates pass; `openspec validate --strict` not run, the CLI is not installed here.
