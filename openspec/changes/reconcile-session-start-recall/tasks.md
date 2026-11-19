# Tasks

## 1. Tests first

- [x] 1.1 `nudge-fixtures.json`: `sessionStart` becomes the deferred-tools hint. `nudge-fixtures.test.ts` gains a `session-start.sh` output-equals-fixture test for both hosts, a "no `memory.context`" assertion, and an explicit post-compact `memory.context` assertion.
- [x] 1.2 `project-resolution-sh.test.ts` and `session-hook-scripts.test.ts` pin the new line on the plain path and on the notice path.
- [x] 1.3 `instructions.test.ts`: the `RECALL:` line contains `if you lack prior detail or a host hook asks` in the path-less, unbound and 64-char-slug variants.
- [x] 1.4 `mcp-tool-surface.test.ts`: `memory.context` joins `CHANGED_DESCRIPTIONS`, and a new test asserts the kept guard, the hook clause, the speculative definition and the length ceiling.
- [x] 1.5 RED observed: 10 failures, each on the intended assertion.

## 2. Implementation

- [x] 2.1 `session-start.sh`: emit the hint, not the recall line.
- [x] 2.2 `instructions.ts`: reclaim from the opening line and extend `RECALL:`. Mirror the change byte-for-byte in Hermes `system_prompt_block`.
- [x] 2.3 `server.ts`: extend the `memory.context` description. Update the measured length pin in `mcp-transport.test.ts` (1521 → 1705).

## 3. Verification

- [x] 3.1 Mutation-check the new guards with `scripts/mutate.mjs`: the `session-start.sh` line, the `RECALL:` clause, the description's kept guard and its speculative definition, and the Hermes mirror. All 5 mutations were caught.
- [x] 3.2 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` on Node 22 (`.nvmrc`): db 368, mcp 474, core 1630, web+plugin 2206. Hermes ran separately with `python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests`: 186 OK. Turbo stopped before `test:hermes-plugin` because of the flake below. One unrelated `mcp-bridge/bridge.test.ts` timing failure passed 3/3 on re-run; the file is untouched by this change.
- [x] 3.3 `pnpm run check:delta-freshness`, `check:delta-sections` and `check:spec-crossrefs` are ok. This change's only body advisory is the deliberate SessionStart output-cap rewrite. `check:spec-provenance` runs after commit, and this change does not touch `openspec/specs/`.
- [x] 3.4 Real Claude Code e2e (2.1.328, headless, scratch `CLAUDE_CONFIG_DIR`, `ENABLE_TOOL_SEARCH=true`, `--strict-mcp-config`), following `e2e-walkthrough.md` §5b. The control arm ran an `upstream/main` server with its hook scripts on :3001, the treatment arm this change on :3000, each with its own seeded scratch DB, using the same flaky-SQLite prompt. The first turn called `memory_context` with `focus`:

  | Arm       | Sonnet | Opus |
  | --------- | ------ | ---- |
  | control   | 2/5    | 5/5  |
  | treatment | 5/5    | 5/5  |

  Every call went through ToolSearch first. The control Sonnet runs that skipped recall gave generic advice; the treatment runs cited the seeded memories. `/compact` on a resumed session fired `post-compact.sh` with its block unchanged (including "Missing detail? memory.context") in both arms. `session-start.sh` ran only for the `resume` source.
