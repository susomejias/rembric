## 1. Tool handler

- [x] 1.1 Add `apps/server/src/mcp/about-tool.ts` exporting a pure builder (e.g. `buildAboutReport()`) that returns the two-axis object: `server: { version: REMBRIC_VERSION, where, update }` and `plugins: { note, interactive, update_all, subset }` plus `docs`. Import `REMBRIC_VERSION` from `../version.js`. No DB, no I/O, no shell.
- [x] 1.2 Source the `plugins` command strings from the canonical installer entrypoint (the same `.../install.sh` URL and `--action=update [--agent=…]` flags the `tui-installer` capability defines); define them as module constants, not hand-forked literals scattered around.
- [x] 1.3 Write the `server.update` string as the manual host command (`docker compose pull && docker compose up -d`) and the `plugins.note` stating plugins live per client machine and the server cannot see them.
- [x] 1.4 Add `plugins.status` as the installer's read-only `--status --json` command (covers server + per-plugin installed-vs-available with a per-agent `action`); update `plugins.note` to direct "run status first, update only where action is `update`". Do not compute status server-side.

## 2. Register the tool

- [x] 2.1 In `apps/server/src/mcp/server.ts`, register `memory.about` next to the existing `memory.doctor` registration, with an empty input schema and a description containing the keywords `update`/`upgrade` and a reference to plugins.
- [x] 2.2 Confirm the tool is advertised in the `initialize` result (it appears in the tool manifest for every client, including opencode and Hermes).

## 3. Cite the tool in instructions

- [x] 3.1 In `apps/server/src/mcp/instructions.ts`, add the shortest possible update-guidance clause naming `memory.about` (≤40 chars of new content) to the shared `BASE` block, so both the path-scoped and unscoped variants carry it.
- [x] 3.2 Verify both `buildInstructions({requestedSlug:'demo'})` and `buildInstructions({requestedSlug:null})` stay ≤800 chars after the addition.
- [x] 3.3 Strengthen the session-summary trigger in `BASE`: rebind `before saying "done"` → `before ending any turn with real work`; compact adjacent clauses (save line, `Summary covers` → `summary:`) to absorb the cost under the 800-char cap. Instructions-only — no hook/plugin change.

## 4. Tests

- [x] 4.1 Add a unit test for `buildAboutReport()` asserting: `server.version === REMBRIC_VERSION`; both axes present; `plugins.note` contains the "server cannot see plugins" wording; the installer URL/flags match the canonical entrypoint; `plugins.status` uses `--status --json` and carries no mutating flag; the report contains no executed side effects (pure function returns the same object on repeat calls).
- [x] 4.2 Add an MCP-level test that calling `memory.about` returns the report and performs no DB access (e.g. against the same harness used by the `memory.doctor` test).
- [x] 4.3 Extend `apps/server/src/mcp/instructions.test.ts`: both variants contain the substring `memory.about`, remain ≤800 chars, assert the session-summary trigger is bound to `before ending any turn with real work` (and NOT to `before saying "done"`), and existing assertions (`memory.session_summary`, `memory.context`, `2000`, `before`, scope notes) still pass.
- [x] 4.4 Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm vitest run apps/server/src/mcp/` green.

## 5. Verification

- [ ] 5.1 (Operator-assisted) Smoke against `pnpm run dev:docker:up`: connect an MCP client, call `memory.about`, confirm the two-axis payload and that `server.version` matches the running image; confirm `initialize.instructions` contains `memory.about`. Per the `rembric-smoke-tests` skill.
- [x] 5.2 Confirm no `apps/plugin/` files changed (`git status apps/plugin/` clean) — the tool ships purely via the server MCP manifest.
