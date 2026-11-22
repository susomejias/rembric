## 1. Pending-work snippet

- [x] 1.1 `pendingSection(doc)` in `packages/core/src/services/summary-sections.ts`. It returns the `## Unfinished+why` heading and trimmed body, or `null` when the section is absent, has an empty body, or only says nothing is pending.
- [x] 1.2 `handleContext` emits `recentSessions[].summary` through `sessionSnippet`. When `pendingSection` returns a section, the snippet is that section bounded by `CONTEXT_PENDING_CHARS = 600`; otherwise it is the opening bounded by `CONTEXT_SNIPPET_CHARS`.
- [x] 1.3 The `memory.context` description names what the snippet shows. The pinned description length in `mcp-transport.test.ts` moves from 1444 to 1521.

## 2. Tests

- [x] 2.1 Unit tests for `pendingSection` in `summary-sections.test.ts`. They cover the section returned, an absent section, an empty body, every "nothing pending" variant, a body that only starts with "None", and a heading inside a fence.
- [x] 2.2 MCP-boundary tests in `mcp-transport.test.ts`:
  - The section is shown instead of the opening, with a 482-character body that exceeds 350 characters.
  - A long section is truncated to exactly 600 characters with `…`.
  - A `none` section falls back to the 350-character opening; this is the control.
  - The existing truncation and verbatim tests still pass.
- [x] 2.3 Mutation-checked with `scripts/mutate.mjs`. Six mutations were all caught: the nothing-pending test, the empty-body test, the regex anchor, the section key, the 600 bound, and the swap itself.

## 3. Verification

- [x] 3.1 `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `openspec validate surface-unfinished-in-context --strict`.
- [ ] 3.2 After release, repeat the 2026-11-12 follow-through measurement over the sessions created since then. Compare the share of pending items never mentioned again against the 53% baseline, and decide on issue #451's todo entity from that.
