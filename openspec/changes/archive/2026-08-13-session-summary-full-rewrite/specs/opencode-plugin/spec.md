## MODIFIED Requirements

### Requirement: Experimental.session.compacting handler

The `"experimental.session.compacting"` handler SHALL:

1. If `input.sessionID` is present, call `ensureSession(input.sessionID)`.
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the post-compaction agent to FIRST read the stored summary with `memory.session_get`, and THEN call `memory.session_summary` with the session's CURRENT COMPLETE state — brought up to date with the surviving window, and with the write's replacing semantics stated, so that sending the compacted window alone is understood to store the window alone. The instruction text SHALL be a single multi-line string. The text SHALL name the project slug when one was resolved. **The text SHALL ALSO direct the post-compact agent to call `memory.context` if it needs detail beyond what it read (file paths, decisions, specific errors not in the compacted block). That escalation — not a data-loss warning — is the only fallback the text SHALL name.** It sits inside the numbered list rather than at the very end: the shared fixture closes by telling the agent to resume the user's request, and the pushed string is that fixture plus the slug sentence, so a requirement that the string END on the `memory.context` sentence would be unsatisfiable against the byte-identity requirement below.

**A dedicated sentence stating that skipping this step loses everything before compaction is NOT required, and SHALL NOT be added as the string's ending.** The risk it would state is already published by the replacing-semantics clause above — the shared fixture's `this REPLACES the stored value` says a thin rewrite overwrites the prior state — so the sentence buys nothing. And the string's ending is not available to it: the byte-identity requirement below fixes the protocol text as the shared fixture, which closes by telling the agent to resume the user's request, with only the per-connection slug sentence appended after that. A sentence added as the ending would break that byte-identity. It was carried over from the pre-rewrite hand-written text rather than derived from this requirement's own obligations.

**The instruction SHALL NOT ask the agent to call `memory.session_summary` with the content of the compacted summary**, and SHALL NOT ask for a summary of the surviving window. That was the shipped framing when this requirement was rewritten — `apps/plugin/.opencode-plugin/plugin.ts:244-252` pushed "call `memory.session_summary` with the content of the compacted summary above." and then "This preserves what was accomplished before compaction." — and against a replacing write it produces exactly the loss the instruction exists to prevent: the model obeys, and the stored summary becomes the window.

This handler was the one compaction surface the read-then-rewrite rewrite missed, and the reason is worth recording because it is a property of the guard rather than of the author: the enumeration that pins the model-facing summary surfaces (`apps/server/src/test/invariants.test.ts::'the session-summary rubric has one source'`) asserts its own completeness from a `git grep` for the canonical section list, and this block never carried that list, so it was never in the enumeration and no test could notice it disagreeing.

The obligations of "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full" apply to this string in full; this handler is the opencode compaction surface named there.

**The protocol sentences SHALL NOT be hand-written in `plugin.ts`.** They SHALL be sourced from the shared cross-language fixture contract (`apps/plugin/test/nudge-fixtures.json`) through the shared JS/TS core (`apps/plugin/bin/rembric-plugin-core.mjs`) and pinned by `apps/plugin/test/nudge-fixtures.test.ts`, on the same single-implementation discipline every other model-facing nudge string already follows. The bash clients embed the `rembric:`-prefixed fixture value and this client embeds the unprefixed `…Core` variant, matching the existing `save`/`saveCore` and `summary`/`summaryCore` pairs; the unprefixed variant SHALL satisfy the same ≤600-byte budget the prefixed one carries under "Plugin-injected protocol nudges MUST surface the summary length cap".

**The ≤600-byte budget binds the shared fixture value alone (`postCompactCore`), never the assembled per-connection string this handler pushes.** The slug sentence appended after it (`Use project: '<slug>'. `) is per-connection data, not protocol text, and its length is not fixed: `SLUG_RE` allows a slug up to 64 characters, and the sentence's own template costs on the order of 17-18 further bytes at a zero-length slug, so a slug somewhere past the low-30s of characters — well within `SLUG_RE`'s own 64-character limit — would put the ASSEMBLED string over 600 bytes if the cap were read that way. That is a bound the requirement never intended: measuring the fixture alone is the established convention for every other per-line cap in this contract (`claude-code-plugin`'s "Per-line caps" table asserts each against the raw `nudge-fixtures.json` value, not a rendered one; its sole exception, `sessionIdTemplate`, is measured rendered because its variable part is a FIXED-length UUID, not an unbounded slug). A future change that wants a ceiling on the assembled string MAY add one, but it SHALL do so explicitly and re-measure against `SLUG_RE`'s actual 64-character maximum rather than a short example slug.

The project-slug sentence remains this client's own addition and is appended to the shared text rather than forked from it: it is the only part of the string that is per-connection data rather than protocol text, so the published obligation to name the slug is satisfied without a second copy of the protocol. A consequence worth stating, because it makes a published enumeration incidentally truer: the shared text carries the `10000` cap substring, so this injection surfaces the cap even though the injection-site list in "Plugin-injected protocol nudges MUST surface the summary length cap" does not name `plugin.ts`.

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint in v1 — no such endpoint exists on the HTTP API today. When the corresponding endpoint ships in a future OpenSpec change, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string (including the memory.context guidance) SHALL remain the last (always-present) entry.

#### Scenario: Reminder includes memory.session_summary AND memory.context guidance

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the substring `memory.context` (new requirement — the post-compact recovery path)
- **AND** that string contains the project slug when one was resolved from `.rembric`
- **AND** that string contains the substring `memory.session_get`, positioned before the `memory.session_summary` directive it is meant to precede

#### Scenario: Compacting fires without sessionID

- **WHEN** `experimental.session.compacting` fires with no `input.sessionID`
- **THEN** `ensureSession` SHALL NOT be called and no HTTP request SHALL be made
- **AND** the instruction string SHALL still be pushed onto `output.context`, unchanged in content — the post-compaction agent needs the directive whether or not this process could identify the session row

#### Scenario: The instruction carries no window-only framing

- **WHEN** the string pushed onto `output.context` is inspected
- **THEN** it SHALL NOT instruct the agent to pass the compacted summary's content, "the compacted summary above", or a summary of the surviving window to `memory.session_summary`
- **AND** it SHALL state that the write replaces the stored value

#### Scenario: The protocol text is the shared one, not a per-client copy

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is inspected
- **THEN** it SHALL NOT declare its own copy of the protocol sentences
- **AND** the sentences it pushes SHALL be byte-identical to the shared fixture's unprefixed post-compaction value, with the slug sentence as the only per-client addition
