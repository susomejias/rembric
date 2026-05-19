<!-- spike result: fire-and-forget -->

## 0. Dispose-event spike (operator-driven, GATES everything below)

- [x] 0.1 Bring up the dev stack: `pnpm run dev:docker:up`. Capture the `demo-writer` token from the seed banner.
- [x] 0.2 Write a sniffer plugin at `~/.config/opencode/plugins/__dispose-sniff.ts` whose `event` dispatcher branches on `event.type === 'server.instance.disposed'` and (a) writes a stderr marker `[SNIFF-DISPOSE-START]`, (b) `await new Promise(r => setTimeout(r, 3000))` to simulate slow async work, (c) `await fetch('http://127.0.0.1:8788/api/demo/sessions', { method: 'POST', headers: {Authorization: 'Bearer <demo-writer>', 'Content-Type': 'application/json'}, body: JSON.stringify({id: 'dispose-spike-<timestamp>', agent: 'opencode'}) })`, (d) writes a stderr marker `[SNIFF-DISPOSE-END]` with the HTTP status code.
- [x] 0.3 Move the real `rembric.ts` plugin aside temporarily so it doesn't fire.
- [x] 0.4 Run `opencode mcp list` (or any short opencode command that exits cleanly). Capture stderr.
- [x] 0.5 Verify the `dispose-spike-<timestamp>` row landed in `data-dev/data.db` via `sqlite3 data-dev/data.db "SELECT id, status FROM sessions WHERE id LIKE 'dispose-spike-%';"`.
- [x] 0.6 Record the result. If the row exists AND both stderr markers were observed AND opencode exited normally after the 3-second await: **awaits-async-handlers**. If the row is missing OR only `[SNIFF-DISPOSE-START]` was observed: **fire-and-forget**. Write the result as a comment at the top of this `tasks.md` (`<!-- spike result: awaits-async-handlers -->` or `<!-- spike result: fire-and-forget -->`).
- [x] 0.7 Restore the real `rembric.ts` plugin. Remove the sniffer plugin. Tear down the dev stack.

## 1. Plugin code: transcript accumulator

- [x] 1.1 In `plugin/.opencode-plugin/plugin.ts`, add the spike-result comment (line ~2): `// dispose-spike-result: <awaits-async-handlers|fire-and-forget>`. Verify the invariant test (added in task 7.4) passes against this comment.
- [x] 1.2 Add a `sessionMessages: Map<string, Array<{role: 'user'|'assistant', text: string, id?: string}>>` declared inside the `RembricPlugin` closure, alongside `knownSessions` and `subAgentSessions`.
- [x] 1.3 Implement two new helpers (NOT exported — opencode invokes every export with ctx):
  - `appendUserMessage(sessionId: string, text: string)`: applies `stripPrivateTags` + `truncate(text, 2000)`, pushes `{role:'user', text}`, FIFO-trims to 200.
  - `upsertAssistantMessage(sessionId: string, messageId: string, text: string)`: applies the same transforms; replaces in-place by id if present, else appends `{role:'assistant', text, id: messageId}`, FIFO-trims to 200.
- [x] 1.4 Register the `"chat.message"` handler per `opencode-plugin::Chat.message handler accumulates user transcript`. Sub-agent filter; extract text from `output.parts` filtering text parts (with fallback to `output.message.summary.{title,body}` like the original v0.7.0 spec); skip if empty; call `appendUserMessage`.
- [x] 1.5 Register the `"message.updated"` handler per `opencode-plugin::Message.updated handler accumulates assistant transcript`. Sub-agent filter; skip if `output.message.role !== 'assistant'`; extract text from `output.message.parts`; skip if empty; call `upsertAssistantMessage(input.sessionID, output.message.id, text)`.

## 2. Plugin code: dispose-flush handler

- [x] 2.1 Implement `formatTranscript(sessionId)` helper: iterates `sessionMessages.get(sessionId)`, renders each entry as `<role>: <text>`, joins with `\n\n`, head-truncates to 19500 chars if longer.
- [x] 2.2 Implement `deriveTitle(sessionId)` helper: finds the first `{role:'user'}` entry in `sessionMessages.get(sessionId)`; returns `text.slice(0, 100)`; returns `undefined` if no user entry exists.
- [x] 2.3 Implement `flushSessionSummary(sessionId)` helper: builds body `{summary: formatTranscript(...), title: deriveTitle(...), final: false}`; OMIT `title` if `undefined` (do NOT serialize the key). POSTs to `/api/${slug}/sessions/${sessionId}/summary` via `rembricPost`. Errors silent (delegated to `rembricPost`'s stderr diag).
- [x] 2.4 Extend the `event` dispatcher with a `server.instance.disposed` branch that iterates `knownSessions` (skipping `subAgentSessions` defensively) and calls `flushSessionSummary` for each. If the spike result was `awaits-async-handlers`: `for (const id of knownSessions) { await flushSessionSummary(id); }`. If `fire-and-forget`: implement the sync-HTTP fallback (`node:http` request without await; document the choice with an adjacent comment block).
- [x] 2.5 Extend the `session.deleted` branch to call `sessionMessages.delete(sessionId)` in addition to the existing `knownSessions.delete` / `subAgentSessions.delete` cleanup.

## 3. Unit tests for accumulators

- [ ] 3.1 In `plugin/.opencode-plugin/plugin.test.ts`, add tests for `appendUserMessage` and `upsertAssistantMessage` behaviour (need to export them as test-only helpers via the dotenv-lib pattern: refactor or carefully accumulate non-exported state). If exporting forces opencode to invoke the helpers as Plugin functions (the previous trap), wrap them behind a single `__testing` namespace export that opencode rejects gracefully — OR move them to a sibling `transcript.ts` helper file imported into plugin.ts (similar pattern to `rembric-dotenv.mjs` consolidation).
- [ ] 3.2 Cover: append-then-FIFO-cap; assistant upsert by id (replace in place, not append); private-tag redaction; truncation; mixed user+assistant interleaving preserves order.
- [ ] 3.3 Cover the `formatTranscript` shape with edge cases: empty array; single user entry (title derives); single assistant entry (no title derived → undefined); 200-entry cap visible in transcript order.

## 4. Handler-level integration tests (mocked fetch)

- [ ] 4.1 Mock `globalThis.fetch`. Construct the plugin via `await RembricPlugin(ctx)`. Drive a sequence of events: `session.created` for `s1`, three `chat.message` calls, two `message.updated` calls with the same id (test upsert), one `message.updated` with a new id, then dispatch `event.type='server.instance.disposed'`. Assert fetch was called once with `/api/demo/sessions/s1/summary`, `final:false`, the correct `summary` shape, and the correct `title`.
- [ ] 4.2 Test the cooperating-agent path: dispatch `session.created`, then SIMULATE the agent calling `memory.session_summary({final:true})` by hand (write a row directly to `data-dev/data.db` in the test fixture; OR rely on the server's precedence rule and assert only the plugin's HTTP behaviour, not the server's). Dispatch `server.instance.disposed`. Assert the dispose POST still fired (the plugin doesn't know about server-side `final` state); server-side preservation is covered by the existing `plugin-session-protocol` write-precedence test.
- [ ] 4.3 Test the sub-agent skip: dispatch a `session.created` with `parentID="parent-1"` for id `"sub-1"`. Dispatch chat.message and message.updated for `"sub-1"`. Dispatch `server.instance.disposed`. Assert NO fetch was called for `"sub-1"`.
- [ ] 4.4 Test handler-set shape per `opencode-plugin::Event handler set`: `Object.keys(handlers).sort()` equals `["chat.message", "event", "experimental.session.compacting", "message.updated"]` (plus `"shell.env"` only if Plan B from the prior cwd spike applies — current state: Plan A, so omitted).

## 5. Invariant tests

- [x] 5.1 Extend `src/test/invariants.test.ts` with a new `dispose-spike result is recorded` invariant: reads `plugin/.opencode-plugin/plugin.ts`, asserts the first 10 lines contain either `// dispose-spike-result: awaits-async-handlers` or `// dispose-spike-result: fire-and-forget` (regex `/^\/\/ dispose-spike-result: (awaits-async-handlers|fire-and-forget)$/m`).
- [ ] 5.2 Extend `src/test/invariants.test.ts` with a `chat.message and message.updated handlers MUST NOT POST` invariant: parse the body of each handler block from `plugin.ts` (regex-bracket-matched), assert neither contains the substring `rembricPost(` or `fetch(`.
- [x] 5.3 Extend `src/test/invariants.test.ts` with a `server.instance.disposed handler MUST exist` invariant: assert `plugin/.opencode-plugin/plugin.ts` contains the literal string `'server.instance.disposed'` to catch accidental removal during future refactors.

## 6. Docs + skill updates

- [ ] 6.1 Update `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md` under the `opencode` section. Add a new bullet: "`server.instance.disposed` is undocumented but real" — explain the discovery path (binary string scan + sniffer plugin), confirm it's dispatched through the generic `event` handler (not as a top-level keyed handler), reference this change.
- [ ] 6.2 Update `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md` with a "Verify dispose-flush" step: after exercising a session, close opencode, query `sqlite3 data-dev/data.db "SELECT id, length(summary) FROM sessions WHERE agent='opencode' ORDER BY started_at DESC LIMIT 5"`, expect non-null summary for every closed session.
- [ ] 6.3 Update `plugin/.opencode-plugin/README.md` with a "How sessions get summarized" section explaining the dispose-flush behaviour, mention that cooperating agents win via `final:true`, and link to the per-client-gotchas reference.
- [ ] 6.4 Update `docs/agents.md` opencode section with the dispose-flush behaviour (one paragraph between "Verify" and "Troubleshooting" or as a new "How summaries work" subsection).

## 7. Version bump + CHANGELOG + invariant lock-step

- [x] 7.1 Bump `plugin/.claude-plugin/plugin.json::version`, `plugin/.codex-plugin/plugin.json::version`, `plugin/.hermes-plugin/plugin.yaml::version`, and the `// @rembric-plugin-version` comment in `plugin/.opencode-plugin/plugin.ts` from `0.7.1` to `0.8.0` (minor — new handler behaviour, no breaking change for existing users).
- [x] 7.2 Add a `plugin/CHANGELOG.md` `[0.8.0] — unreleased` entry summarising: "opencode plugin now POSTs `/summary` at session close via the undocumented `server.instance.disposed` event. Two new handlers (`chat.message`, `message.updated`) accumulate the transcript in-memory; the dispose-flush sends `final:false` summary so cooperating-agent `memory.session_summary({final:true})` writes still win. Sub-agents are skipped. opencode hard-crash before dispose still loses the transcript — same risk as Claude/Codex hook fallbacks."
- [x] 7.3 Verify the existing `plugin version lock-step` invariant test passes against the new versions.

## 8. Validation

- [x] 8.1 `pnpm vitest run` — all green (existing + new unit/handler tests + new invariants).
- [x] 8.2 `pnpm run typecheck` — 0 errors.
- [x] 8.3 `pnpm run lint` — 0 errors.
- [x] 8.4 `openspec validate add-opencode-session-summary-on-dispose --strict` — valid.

## 9. End-to-end manual smoke (operator + dev)

- [ ] 9.1 Bring up dev stack. Re-install the plugin via `PLUGIN_SRC + BIN_SRC` against the local checkout.
- [ ] 9.2 Launch opencode in a `.rembric`-equipped repo. Drive a session with 3-4 user prompts and at least one assistant response. Close opencode.
- [ ] 9.3 Verify in the dashboard at `/dashboard/sessions` that the session row's `summary` is non-null and contains the transcript ordered oldest-first with `user:` / `assistant:` prefixes.
- [ ] 9.4 Verify `status` stays `'active'` (NOT `'ended'`).
- [ ] 9.5 Verify `title` is the first user prompt truncated to 100 chars.
- [ ] 9.6 Test cooperating-agent precedence: drive another session where the agent calls `memory.session_summary({summary:'X', title:'Y', final:true})` (or the dashboard route equivalent if needed). Close opencode. Verify the row's `summary` is `"X"` (NOT overwritten by the dispose-flush) and `title` is `"Y"`.
- [ ] 9.7 Test sub-agent suppression: if opencode can spawn a sub-agent via its UI, do so and verify only the top-level session row got a dispose-flush summary.
- [ ] 9.8 Tear down dev stack. Uninstall plugin. Restore user config.

## 10. Wrap-up

- [ ] 10.1 Commit on a feature branch (Conventional Commits subject + body ≤100 chars per line). PR body links to the archived proposal/design.
- [ ] 10.2 PR review + merge.
- [ ] 10.3 After merge: archive the change via `/opsx:archive add-opencode-session-summary-on-dispose`.
