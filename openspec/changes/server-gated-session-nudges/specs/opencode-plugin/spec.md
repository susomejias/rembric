## REMOVED Requirements

### Requirement: The opencode plugin SHALL emit unified per-turn save and summary nudges on `chat.message`

**Reason**: The requirement's identity is the cadence it names — "per-turn", "unified save and summary" — and both go. The firing decision moves to the server (`session-nudges`); `SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY` and the per-session `userTurnCounts` map are deleted; and the two nudges become one server-composed notice this handler prints rather than composes. What survives is the CHANNEL: `output.parts` text parts remain the way this client injects lines, and the recall nudge is unchanged. The replacement below is stated in terms of printing and reporting.

**Migration**: No operator action. A running opencode against an old server gets `404` on the report, caches nothing, and prints only its local lines.

## ADDED Requirements

### Requirement: The opencode plugin SHALL report each turn on `session.idle` and print the server's lines on `chat.message`

`apps/plugin/.opencode-plugin/plugin.ts` SHALL participate in the report-and-print contract (`session-nudges`) through the two events it already registers, adding no new event registration.

**Reporting, on `session.idle`.** That branch already fires once per agent turn, after the assistant response completes and before the next user prompt, which is exactly the end-of-turn moment the contract names. It SHALL, in addition to the debounced transcript flush it already performs, call the shared core's turn-report helper for the session, passing whether a tool was observed during the turn, and SHALL cache the returned lines. Subagent sessions SHALL NOT be reported.

**Observing tool use.** The `message.part.updated` branch SHALL set a per-session flag when it sees a part whose `type` is exactly `"tool"` — that branch already inspects `part.type` and returns early for everything that is not `text`, so the observation costs one comparison on a path that already runs. The flag SHALL be read and cleared by the report on `session.idle`. **The concrete type is pinned, and it is NOT "anything that is not `text`":** the installed SDK's `Part` union enumerates `text`, `subtask`, `reasoning`, `file`, `tool`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry` and `compaction`, so a not-`text` test reports tool use for a turn that only thought out loud or emitted a step marker. If a future host emits no `tool` part for a tool invocation, this client falls under the fail-open rule in `session-nudges` and reports `true`, and this requirement SHALL be amended to say so.

**Printing, on `chat.message`.** The handler SHALL push the cached lines — the sessionId line first, then the server's lines verbatim — as separate `output.parts` text parts, each through the existing `nudgePart` helper, since opencode validates every pushed part against its real `TextPart` schema and a bare `{ type: 'text', text }` takes down the turn. Reading the cache SHALL clear it. The recall nudge and the session opening are pushed by the same handler from the shared fixtures and are independent of the notice: any combination MAY fire on the same turn and none replaces another.

**The handler SHALL compose no reminder text of its own.** The unprefixed `…Core` fixture variants remain the source for the client-composed lines; the notice arrives already prefixed from the server.

Subagent sessions SHALL neither be reported nor printed to (the handler's existing subagent guard covers both). The per-session cache and tool flag SHALL be evicted in the existing `session.deleted` cleanup, alongside `sessionMessages` and `assistantParts`.

#### Scenario: One report per turn, from `session.idle`

- **GIVEN** a non-subagent opencode session driven through three user prompts and three assistant responses
- **WHEN** the three `session.idle` events have fired
- **THEN** exactly three turn reports SHALL have been issued
- **AND** no report SHALL have been issued from `chat.message`

#### Scenario: A tool part is observed and reported

- **GIVEN** a turn during which `message.part.updated` fired with a part whose `type` is `"tool"`
- **WHEN** `session.idle` fires
- **THEN** the report SHALL carry `usedTools: true`
- **AND** the control SHALL pass in the same run: a turn whose only non-`text` parts are `reasoning`, `snapshot` or the step markers SHALL report `usedTools: false`

#### Scenario: The flag survives the whole turn, not just the last part

- **GIVEN** a turn whose part sequence is a tool part followed by several `text` parts of the assistant's closing answer
- **WHEN** `session.idle` fires
- **THEN** the report SHALL carry `usedTools: true`
- **AND** the flag SHALL have been set once and read once, rather than recomputed from the most recent part

#### Scenario: The server's lines are pushed verbatim, as valid parts

- **GIVEN** a cached notice from the previous turn's report
- **WHEN** `chat.message` next fires for that session
- **THEN** each line SHALL be pushed as its own `output.parts` entry built by `nudgePart`, carrying `id`, `sessionID` and `messageID`
- **AND** the text of each SHALL be byte-identical to the corresponding line in the report's response
- **AND** the cache SHALL be cleared, so the next `chat.message` pushes neither

#### Scenario: The plugin declares no reminder text and no cadence

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is read at HEAD
- **THEN** it SHALL contain no `SAVE_NUDGE_EVERY`, no `SUMMARY_NUDGE_EVERY`, no turn-count map and no modulo
- **AND** it SHALL declare no string directing the model to save or to summarise

#### Scenario: Subagent sessions are neither reported nor printed to

- **WHEN** the message or idle event belongs to a sub-agent session
- **THEN** no report SHALL be issued and no line SHALL be pushed (early return, as today)

## MODIFIED Requirements

### Requirement: Session.idle handler (periodic flush)

The `event` dispatcher's `"session.idle"` branch is the PRIMARY mechanism that delivers the transcript to the server during the session lifetime, and it is also this client's end-of-turn moment. It fires once per agent turn (after the assistant response completes and before the next user prompt). The branch SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Schedule a debounced flush for `input.sessionID` with a 500ms quiet period. If a prior debounce-timer is pending for the same session id, cancel it and schedule afresh. Implementation note: use `setTimeout` / `clearTimeout` plus a `Map<string, ReturnType<typeof setTimeout>>` to track per-session pending timers.
3. The debounced flush callback SHALL call `flushSessionSummary(sessionId)` (the shared helper used by `server.instance.disposed`), which POSTs `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`.
4. **Issue the per-turn report** (`session-nudges`) through the shared core, reading and clearing the per-session tool-observation flag, and cache the returned lines for the next `chat.message`. The report SHALL NOT be folded into the debounce: the debounce exists to coalesce a burst of idle events into one transcript POST, whereas the report must correspond one-to-one with turns, and a coalesced report would under-count work and lose a notice.

Rationale for the flush: opencode's `server.instance.disposed` is fire-and-forget at the runtime level (verified by spike — see design.md::Decision 4 resolved). Async POSTs from that handler don't land. The per-turn flush keeps the server's summary current at all times so that even if `server.instance.disposed` fails to deliver, the row is at-most-one-turn behind reality. **That flush is retained deliberately and SHALL NOT be removed as part of moving the nudge to the server**: this client's in-memory accumulator holds the only copy of its transcript, and the convergence guarantee in `plugin-session-protocol` rests on it.

The debounce SHALL NOT exceed 2 seconds (don't accumulate too much state in-flight) and SHALL NOT be below 200ms (don't POST on every keystroke during streaming).

#### Scenario: session.idle fires periodic flush per turn

- **GIVEN** a session "s1" with three user prompts each followed by an assistant response, accumulator contains user+assistant turns
- **WHEN** the `event` dispatcher receives `session.idle` after the third assistant turn
- **THEN** within 500ms a POST to `/api/<slug>/sessions/s1/summary` is issued
- **AND** the body's `summary` contains all six turns

#### Scenario: Rapid-fire session.idle events debounce the flush but not the report

- **GIVEN** the `event` dispatcher receives `session.idle` three times within 100ms for the same session id
- **WHEN** the debounce timer expires
- **THEN** exactly ONE `/summary` POST is issued (the prior timers were cancelled)
- **AND** the report path SHALL be governed by turn boundaries rather than by that timer, so a burst within one turn SHALL NOT be reported three times

### Requirement: Message.part.updated handler accumulates assistant transcript

The `event` dispatcher's `"message.part.updated"` branch SHALL:

1. **Record that the turn used a tool when `properties.part.type` is exactly `"tool"`**, setting a per-session boolean the `session.idle` report reads and clears (`session-nudges`). This SHALL happen before the early return in step 2, because that return is precisely the branch a tool part takes.
2. Return immediately if `properties.part.type !== "text"`.
3. Return immediately if `properties.part.sessionID`, `properties.part.messageID`, or `properties.part.id` is empty.
4. Return immediately if `properties.part.sessionID` is in `subAgentSessions`, or is not in `knownSessions`.
5. Return immediately if `messageRoles.get(properties.part.messageID) !== "assistant"`. This is a no-op for user-authored parts (captured instead by `chat.message`) and for parts seen before their owning message's `message.updated` event — an accepted at-most-one-part-dropped race, matching the "opt out until known" pattern used elsewhere in this plugin.
6. Record `properties.part.text` in a closure-scoped `Map<string, Map<string, string>>` (`assistantParts`), keyed first by `messageID` then by `part.id` (a message can carry multiple text parts).
7. Join all part texts for that `messageID` (insertion order) with `\n`, apply the same `stripPrivateTags` and truncate-to-2000 transforms as `chat.message`, and upsert `{role:'assistant', text, id:<messageID>}` into `sessionMessages` (replace if an entry with that id exists, else append; FIFO-evict past the 200-entry cap).

The branch MUST be idempotent under streaming updates: opencode fires `message.part.updated` many times per assistant turn (token-by-token, and potentially once per distinct part). The id-keyed replacement in step 7 ensures only one final-state entry per assistant message in the accumulator. The tool flag in step 1 is idempotent by construction — it is set, never counted.

**The concrete part type SHALL be pinned to the SDK's `"tool"` literal, not to "not `text`"**, because `plugin.ts` types `part.type` as an open `string` and the union carries ten other members that are not tool use. If the host emits no `tool` part for a tool invocation, this client falls under the fail-open rule in `session-nudges` and reports `true`, and this step SHALL be rewritten to say so rather than left describing a signal that does not arrive.

`messageRoles`, `assistantParts`, the per-session tool flag and the per-session line cache MUST be cleared when that session's `session.deleted` event fires (alongside the existing `sessionMessages`/`pendingFlush` cleanup), to avoid unbounded growth across a long-running opencode server process. The `userTurnCounts` map named in the previous version of this cleanup no longer exists.

#### Scenario: Assistant text is appended on first sight, replaced on subsequent updates

- **GIVEN** `sessionMessages.get("s1")` is `[]` and `messageRoles.get("m1") === "assistant"`
- **WHEN** the `event` dispatcher receives `message.part.updated` with `part.messageID="m1"`, `part.id="p1"`, `part.sessionID="s1"`, text `"Hello,"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello,', id:'m1'}]`
- **WHEN** the dispatcher receives `message.part.updated` again with the SAME `part.id="p1"` and longer text `"Hello, working on it."`
- **THEN** the entry's text is replaced; the array length stays at 1; the entry's position is unchanged
- **WHEN** the dispatcher receives `message.part.updated` with `part.messageID="m2"`, `part.id="p2"`, text `"Done."` (and `messageRoles.get("m2") === "assistant"`)
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello, working on it.', id:'m1'}, {role:'assistant', text:'Done.', id:'m2'}]`

#### Scenario: A tool part sets the tool flag and is otherwise ignored

- **GIVEN** a session "s1" in `knownSessions`
- **WHEN** the dispatcher receives `message.part.updated` with `part.sessionID="s1"` and `part.type="tool"`
- **THEN** the per-session tool flag for "s1" SHALL be set
- **AND** `sessionMessages.get("s1")` SHALL be unchanged
- **WHEN** the dispatcher instead receives a part whose `type` is `"reasoning"`, `"snapshot"` or `"step-start"`
- **THEN** the flag SHALL NOT be set

#### Scenario: Non-assistant roles and unregistered sessions are ignored

- **WHEN** the `event` dispatcher receives `message.part.updated` for a `part.messageID` whose `messageRoles` entry is `"user"`, `"system"`, `"tool"`, or absent
- **THEN** the branch returns without mutating `sessionMessages`
- **WHEN** the `event` dispatcher receives `message.part.updated` for a `part.sessionID` not in `knownSessions`
- **THEN** the branch returns without mutating `sessionMessages`

### Requirement: Experimental.session.compacting handler

The `"experimental.session.compacting"` handler SHALL:

1. If `input.sessionID` is present, call `ensureSession(input.sessionID)`.
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the post-compaction agent to FIRST read the stored summary with `memory.session_get`, and THEN call `memory.session_summary` with the session's CURRENT COMPLETE state — brought up to date with the surviving window, **and with the write's section-wise merge semantics stated: each `##` section the write carries replaces its stored counterpart and a section the write omits keeps its stored text, so sending the compacted window alone replaces every section the window happens to mention and leaves the rest silently stale.** The instruction text SHALL be a single multi-line string. The text SHALL name the project slug when one was resolved. **The text SHALL ALSO direct the post-compact agent to call `memory.context` if it needs detail beyond what it read (file paths, decisions, specific errors not in the compacted block). That escalation — not a data-loss warning — is the only fallback the text SHALL name.** It sits inside the numbered list rather than at the very end: the shared fixture closes by telling the agent to resume the user's request, and the pushed string is that fixture plus the slug sentence, so a requirement that the string END on the `memory.context` sentence would be unsatisfiable against the byte-identity requirement below.

**A dedicated sentence stating that skipping this step loses everything before compaction is NOT required, and SHALL NOT be added as the string's ending.** The risk it would state is already published by the merge clause above — the shared fixture says what a write does to each section, so a thin rewrite is understood to overwrite the sections it names and to leave the others behind — so the sentence buys nothing. And the string's ending is not available to it: the byte-identity requirement below fixes the protocol text as the shared fixture, which closes by telling the agent to resume the user's request, with only the per-connection slug sentence appended after that. A sentence added as the ending would break that byte-identity.

**The previous form of that rationale is corrected rather than merely reworded, and this change owns the correction.** It argued from `this REPLACES the stored value` — the fixture's own words at the time — and read "a thin rewrite overwrites the prior state". After `refine-session-summary-writes` that is true only of a rewrite carrying every stored heading. The danger is unchanged in kind and different in shape: a thin rewrite now overwrites what it names and silently ages what it omits, which is why the fixture's wording moves with the rationale rather than being left behind it.

**The instruction SHALL NOT ask the agent to call `memory.session_summary` with the content of the compacted summary**, and SHALL NOT ask for a summary of the surviving window. That was the shipped framing when this requirement was first rewritten — `apps/plugin/.opencode-plugin/plugin.ts:244-252` pushed "call `memory.session_summary` with the content of the compacted summary above." and then "This preserves what was accomplished before compaction." — and against a merging write it still produces loss, now as staleness rather than as replacement.

This handler was the one compaction surface the read-then-rewrite rewrite missed, and the reason is worth recording because it is a property of the guard rather than of the author: the enumeration that pins the model-facing summary surfaces (`apps/server/src/test/invariants.test.ts::'the session-summary rubric has one source'`) asserts its own completeness from a `git grep` for the canonical section list, and this block never carried that list, so it was never in the enumeration and no test could notice it disagreeing.

The obligations of "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full" apply to this string in full; this handler is the opencode compaction surface named there.

**The protocol sentences SHALL NOT be hand-written in `plugin.ts`.** They SHALL be sourced from the shared cross-language fixture contract (`apps/plugin/test/nudge-fixtures.json`) through the shared JS/TS core (`apps/plugin/bin/rembric-plugin-core.mjs`) and pinned by `apps/plugin/test/nudge-fixtures.test.ts`, on the same single-implementation discipline every other model-facing line follows. The bash clients embed the `rembric:`-prefixed fixture value and this client embeds the unprefixed `…Core` variant; the unprefixed variant SHALL satisfy the same ≤600-byte budget the prefixed one carries under "Plugin-injected protocol nudges MUST surface the summary length cap", and **the reworded text SHALL be re-measured against it in the same commit** (last measured: 675 bytes prefixed, 666 unprefixed, before the merge correction).

**The ≤600-byte budget binds the shared fixture value alone (`postCompactCore`), never the assembled per-connection string this handler pushes.** The slug sentence appended after it (`Use project: '<slug>'. `) is per-connection data, not protocol text, and its length is not fixed: `SLUG_RE` allows a slug up to 64 characters, and the sentence's own template costs on the order of 17-18 further bytes at a zero-length slug, so a slug somewhere past the low-30s of characters would put the ASSEMBLED string over 600 bytes if the cap were read that way. That is a bound the requirement never intended: measuring the fixture alone is the established convention for every other per-line cap in this contract. A future change that wants a ceiling on the assembled string MAY add one, but it SHALL do so explicitly and re-measure against `SLUG_RE`'s actual 64-character maximum rather than a short example slug.

The project-slug sentence remains this client's own addition and is appended to the shared text rather than forked from it: it is the only part of the string that is per-connection data rather than protocol text. A consequence worth stating: the shared text carries the `10000` cap substring, so this injection surfaces the cap even though the injection-site list in "Plugin-injected protocol nudges MUST surface the summary length cap" does not name `plugin.ts`.

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint — no such endpoint exists on the HTTP API today. When one ships, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string SHALL remain the last (always-present) entry.

#### Scenario: Reminder includes memory.session_summary AND memory.context guidance

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the substring `memory.context`
- **AND** that string contains the project slug when one was resolved from `.rembric`
- **AND** that string contains the substring `memory.session_get`, positioned before the `memory.session_summary` directive it is meant to precede

#### Scenario: The pushed string states the merge, not a whole-document replacement

- **WHEN** the string pushed onto `output.context` is inspected
- **THEN** it SHALL state that the `##` sections the write carries replace their stored counterparts and that omitted sections keep their stored text
- **AND** it SHALL NOT state that the write REPLACES the stored value without qualification

#### Scenario: Compacting fires without sessionID

- **WHEN** `experimental.session.compacting` fires with no `input.sessionID`
- **THEN** `ensureSession` SHALL NOT be called and no HTTP request SHALL be made
- **AND** the instruction string SHALL still be pushed onto `output.context`, unchanged in content

#### Scenario: The instruction carries no window-only framing

- **WHEN** the string pushed onto `output.context` is inspected
- **THEN** it SHALL NOT instruct the agent to pass the compacted summary's content, "the compacted summary above", or a summary of the surviving window to `memory.session_summary`

#### Scenario: The protocol text is the shared one, not a per-client copy

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is inspected
- **THEN** it SHALL NOT declare its own copy of the protocol sentences
- **AND** the sentences it pushes SHALL be byte-identical to the shared fixture's unprefixed post-compaction value, with the slug sentence as the only per-client addition
