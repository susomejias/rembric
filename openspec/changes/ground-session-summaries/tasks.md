## 0. Before-picture, measured not remembered

- [ ] 0.1 Reproduce the composed-truncation defect end to end: build a transcript long enough to exceed both bounds, run it through the real `stop-sync.sh` path against a live server, and show that the persisted `summary` is a middle window — that its first characters are NOT the transcript's first characters and its last characters are NOT the transcript's last. Record the exact character offsets. A test that only checks `truncateSummary` in isolation does not prove the composition.
- [ ] 0.2 Record how often this actually bites on the seeded dev corpus and, if available, on a real instance: how many sessions have `summary_final = 0` and `length(summary)` at or within a few characters of `SUMMARY_MAX_CHARS`. If the count is zero, say so — the defect is still real but the priority argument changes and the change should say which.
- [ ] 0.3 Enumerate every surface that states the summary structure to a model, with file and line, and record the exact text of each. Expected: six sites, five naming five sections and one naming seven. Confirm or correct that count before building the single-source constant around it.

## 1. Truncation: one direction, one constant

- [ ] 1.1 Make `truncateSummary` tail-keeping with a leading marker: `marker + s.slice(-(SUMMARY_MAX_CHARS - marker.length))`, still surrogate-pair safe, still never exceeding `SUMMARY_MAX_CHARS`.
- [ ] 1.2 Test the boundary arithmetic directly: exactly `SUMMARY_MAX_CHARS` is unchanged; `+1` yields a marked result of exactly `SUMMARY_MAX_CHARS`; the result's tail equals the input's tail; a surrogate pair at the cut point is not split. **Mutate each assertion** — restore head-keeping and confirm the tail assertion fails, because an assertion on length alone passes under both directions.
- [ ] 1.3 Derive the plugin's wire bound from the server constant instead of maintaining `RBR_TRANSCRIPT_MAX_CHARS = 19500` independently. It SHALL NOT exceed the server cap. Keep the plugin's tail-keep, and cut at a record boundary rather than mid-record.
- [ ] 1.4 Add a fixture that fails if the plugin's bound and the server constant diverge. The two numbers disagreeing by a factor of two is the whole defect; nothing currently notices.
- [ ] 1.5 Confirm no migration is needed and say why in the task: truncation is a write-time transform and stored rows are never rewritten. Rows written before this change keep their head-slice — which is the reason the marker's position must distinguish the two.

## 2. The fallback carries facts, not a slice

- [ ] 2.1 Add the deterministic extraction beside the existing per-parser transcript seam (`rembric_format_transcript_<parser>`), NOT as a new parallel seam. Emit: files created/written/edited, commands run with failures identified, tools used, final exchange.
- [ ] 2.2 Do not include diffs. Record the reason in the task rather than only in the design, so a later reader does not re-add them: the cap cannot hold them and git already has them.
- [ ] 2.3 Fixture-test the extraction against a committed transcript sample per parser. Assert the failed command is identified AS failed — an extraction that lists commands without their status is the version of this that looks right and is useless.
- [ ] 2.4 Prove the traceability property is real, not asserted: every emitted line must correspond to a transcript event. Test it by feeding a transcript and asserting the output contains no path and no command absent from the input.
- [ ] 2.5 Prove the truncation-degradation property: take an extraction longer than the cap, truncate it through the real helper, and assert the surviving text is still a well-formed fact list — not a fragment beginning mid-record.
- [ ] 2.6 Unparseable transcript → previous behaviour, exit 0, no malformed body. Test the failure path explicitly; a fallback that throws is worse than no fallback.

## 3. The end-of-turn gate

- [ ] 3.1 **Answer Open Question 1 from the host contract before writing any code**: does the end-of-turn payload carry a loop-guard signal, and under what name? Read the host's documented contract; do not infer it from behaviour. Record the answer verbatim with its source. If absent, ship the gate as non-blocking feedback and record that the blocking form was not available — do NOT guess a field name.
- [ ] 3.2 Split the end-of-turn wiring into the existing async raw-sync entry plus a new synchronous entry. Do not make the raw sync synchronous — it is a side effect and must not delay the turn.
- [ ] 3.3 Implement the synchronous entry: one bounded request; silent exit when a curated summary exists or the session has nothing worth summarising; otherwise the continue decision with a reason carrying the canonical structure plus the extracted facts.
- [ ] 3.4 Implement fail-open and test every branch of it separately: non-2xx, timeout, unparseable response, missing configuration, unexpected error. Each must exit 0 with no output. **Mutate the handler to fail closed and confirm each test fails** — this is the assertion that keeps a memory server from being able to break a host, and it is worth more than the feature.
- [ ] 3.5 Implement at-most-once using the signal from 3.1. Test the second firing exits silently even when no summary was written.
- [ ] 3.6 Budget the added end-of-turn latency, state the budget before measuring, and measure it. If it exceeds the budget, ship the gate as non-blocking feedback on the async entry instead and record the measurement as the reason.
- [ ] 3.7 Wire the same gate for every client whose host exposes an end-of-turn event, and record per client whether it does. Do not assume parity across the four clients.

## 4. One rubric, one source

- [ ] 4.1 Define the canonical structure once as an exported constant, with the enriched sections: goal, work accomplished, decisions and their reasons, what was verified and how, what was left unfinished and why, files.
- [ ] 4.2 Point every surface from 0.3 at the constant. Include `post-compact.sh` — a compaction is exactly when the structure matters most and it currently carries its own copy.
- [ ] 4.3 Keep the MCP tool description terse and re-assert it against `DESCRIPTION_MAX_LENGTH`. Record the measured length and the remaining headroom. If the terse pointer does not fit, cut prose elsewhere in that description rather than raising the constant — the constant exists because the host truncates above it.
- [ ] 4.4 Add the divergence fixture: enumerate the surfaces, assert each carries text derived from the constant, and assert the enumeration itself is complete by counting call sites. **Mutate one surface's text and confirm the fixture fails**; a fixture that only checks the constant exists would have passed against all six divergent copies.

## 5. Delegated work

- [ ] 5.1 Wire the subagent-completion event to append its extracted facts to the parent session's record.
- [ ] 5.2 Assert it never returns an interrupting decision, whatever the parent's summary state.
- [ ] 5.3 Test the case that motivates it: a session that edited nothing directly but whose subagents edited several must not produce an empty-looking fallback.

## 6. Specs and archive

- [ ] 6.1 Apply the `sessions` delta. Both MODIFIED requirements reproduce every published scenario — 5 on the structure requirement and 7 on the cap requirement. **Verify that count against the published file before archiving**: the previous change had four scenarios silently dropped by its delta and the archiver caught it, after that change's own task had claimed nothing was lost.
- [ ] 6.2 Apply the `plugin-session-protocol` delta (ADDED only, so no published scenario is at risk).
- [ ] 6.3 Grep `openspec/specs/` for `Goal · Discoveries`, `Goal /`, `truncat`, and `19500`, and reconcile every hit. Any spec that states the head-truncation behaviour becomes false the moment this lands.
- [ ] 6.4 Re-check `mcp-api`'s truncation-ceiling requirement still reads true after 4.3 changes the description, and reconcile it in the same commit if it does not.

## 7. Verify

- [ ] 7.1 `pnpm run typecheck`, `pnpm run lint`, full test suite.
- [ ] 7.2 Real end-to-end against the dev stack, driving the actual hook scripts rather than calling the helpers: a session that writes a curated summary must not be interrupted; a session that does not must be interrupted exactly once; a stopped server must not interrupt at all. Testing the helpers in isolation does not exercise the wiring, and the wiring is where the `async: true` defect lived.
- [ ] 7.3 Confirm the disabled/unconfigured path is inert: with no server URL or token configured, every new hook entry exits 0 and writes nothing.
- [ ] 7.4 Run the `rembric-plugin-development` e2e walkthrough — this change touches `apps/plugin/` hook manifests for more than one client.

## 8. Deferred, recorded so it is not lost

- [ ] 8.1 Surfacing uncurated summaries in `memory.context` is **not** in this change. It becomes defensible once the fallback is structured facts rather than a dump, but it needs its own measurement of the effect on context size. Open it as a follow-up citing this change's extraction format.
- [ ] 8.2 Server-side model summarisation of a session that ended raw is **not** in this change. The consolidation sweep is contractually deterministic with no LLM and no cron; introducing one is a decision about cost and latency that belongs to its own change.
- [ ] 8.3 Keeping both ends of an over-cap summary and eliding the middle is **rejected for now**, not forgotten: it needs a policy for splitting the budget and produces a discontinuity that is harder to read and to assert than a clean tail. Revisit only if 0.2's measurement shows the opening carries something the extraction does not already surface.
- [ ] 8.4 Raising `SUMMARY_MAX_CHARS` is **rejected** on the grounds recorded in design D2. If real sessions still truncate after §2 lands, that measurement is the trigger to reconsider — and the constant is one line, with no migration.
