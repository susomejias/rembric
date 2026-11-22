## 1. Pi

- [x] 1.1 `RARELY_USED_TOOLS` in `rembric-plugin-core.mjs` and its `.d.mts` declaration.
- [x] 1.2 `index.ts`: activate `tool_search` and register the set with `exposure: "deferred"` only when the host lists a `tool_search` that declares `reachesTools`; fall back to every tool direct otherwise, including when the host API throws.
- [x] 1.3 `index.ts`: no instructions on a suppressed run.
- [x] 1.4 Tests through the extension's public interface against a real server: deferral, direct tools, identical schemas, a deferred tool's proxied call, the legacy, unreachable, codemode-only and throwing hosts, no double activation, suppressed runs and the primary-run control. Observed red before the change.

## 2. opencode

- [x] 2.1 Reproduce the stale block with a V2 test (red), then store each prompt's block, an empty one included.

## 3. Verification

- [x] 3.1 Mutation-check every new guard with `scripts/mutate.mjs`.
- [x] 3.2 Re-measure per-request bytes before and after, main and sub-agent runs.
- [x] 3.3 Focused suites, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `openspec validate reduce-plugin-per-turn-token-cost --strict`.
