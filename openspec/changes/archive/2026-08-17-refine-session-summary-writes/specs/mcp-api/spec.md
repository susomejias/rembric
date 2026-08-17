## MODIFIED Requirements

### Requirement: The `memory.session_summary` description MUST state that the write replaces the stored summary and ask for the current complete state

The tool's own description is the longest text a model reads about this tool before calling it, and it is the surface every client reaches — including the one that discovers tools with `tools/list` rather than enumerating them. It SHALL therefore carry the write's semantics, not only its arguments. The description SHALL state, in its own words but with all ten facts present:

1. **That the write REPLACES the `##` sections it carries and KEEPS the ones it omits.** This is the single most important sentence in the description: a model that believes an omitted section is deleted will retype the whole document from a context window that no longer holds it, and will silently drop what it cannot see. The two halves SHALL appear together — a description that states only the replacing half teaches the destructive reading.
2. **That the write REFINES the session's state rather than reporting the turn.** The summary asked for is the state that holds now for the whole session, concise rather than exhaustive, and what is new is ADDED to what is already there.
3. **That sending only the sections that changed is the expected use.** A partial write is not a degraded write.
4. **That a section's body is always that section's full current state.** What may be omitted is a section, never part of one.
5. **CONDENSE, NEVER DELETE.** Shrinking a section is legitimate compaction — at a 10 000-character cap it is the correct response to running out of room — while making a section disappear is loss. A section that has genuinely emptied SHALL be written as its heading with an explicit short value (`none`), because there is no input that removes a heading.
6. **That an over-cap MERGE is refused and nothing is truncated**, with the resolution named: condense the sections and resend.
7. **That the current state goes FIRST.** The reason SHALL be given, because a bare ordering instruction reads as a style rule and is the first thing a model drops under length pressure: `memory.context` shows only the beginning of a stored summary, so the opening lines are the preview a later session sees, and the full text is available only to a model that calls `memory.session_get`.
8. **That a model which cannot see its earlier work SHALL read the stored summary first** via `memory.session_get`, rather than write only what its window still holds.
9. **That carried-forward facts SHALL be copied, not paraphrased.** File paths with line numbers, measurements, test names and error strings SHALL be copied verbatim from what the model already knows into the new summary text, rather than restated in its own words — a rephrased number is a lost number, because a later reader (human or model) can `grep` a copied fact but not a paraphrase of it.
10. **That the body uses the canonical Markdown structure.** It SHALL name exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`, and SHALL state that each level-2 heading belongs on its own line rather than in one flat paragraph.

**`title` SHALL be actively discouraged, not merely left optional.** It is in the tool's signature, so a model supplies one on every call unless the description says otherwise — which is how a session spanning sixteen hours of work on the MCP bridge came to be titled after the CI fix of its last turn. The description SHALL say to send `title` on the session's FIRST curated write, or when the stored title has stopped describing the work, and to omit it otherwise; and SHALL say that omitting it keeps the stored title. It SHALL NOT be locked: a session that genuinely changes direction has to be able to retitle.

The description SHALL NOT instruct the model to summarise the current window, to send a summary whose CONTENT is only what is new, or to report the turn — any of which makes the stored summary a turn report. Instructing it to send only the SECTIONS that changed is required by fact 3 and is not the prohibited framing: the distinction is that each section sent still carries that section's full current state (`sessions`, "A session summary MUST follow the documented structure").

These obligations SHALL be discharged in the top-level description text, not only in a per-argument zod `describe()`, and SHALL be satisfied within `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"). The cap SHALL NOT be raised to accommodate them: the description measured 670 characters against a 1900-character ceiling when this requirement was first written, and 1295 characters immediately before the merge obligations were added. The shipped text measures **1894 of 1900**, read from a real `tools/list` — six characters of headroom, so a further addition here is not a small one. If that ever ceases to fit, prose is cut instead of raising the cap. The emitted `tools/list` value, not a source estimate, is the authoritative measurement.

One published statement about this tool remains true verbatim and SHALL NOT be weakened by this requirement: the tool keeps `idempotentHint: true` under "Every MCP tool MUST advertise behavioral annotations", because a repeat that changes no section stores the same bytes and therefore still has no additional effect.

#### Scenario: The description names the merge semantics with both halves

- **WHEN** the `memory.session_summary` description is read from a real `tools/list` response
- **THEN** it SHALL state that the `##` sections the write carries replace their stored counterparts
- **AND** it SHALL state that a `##` section the write omits keeps its stored text
- **AND** it SHALL state that sending only the sections that changed is the expected use
- **AND** it SHALL state that the current state comes first, with the reason that only the beginning is shown in `memory.context`
- **AND** it SHALL name `memory.session_get` as the way to read what is stored before writing
- **AND** it SHALL require the six canonical `##` headings on separate lines

#### Scenario: The description says condense rather than delete, and names the escape hatch

- **WHEN** the same description is inspected
- **THEN** it SHALL state that shrinking a section is acceptable and making one disappear is not
- **AND** it SHALL state how to record a section that has genuinely emptied, rather than leaving omission as the only expression of "nothing here"
- **AND** it SHALL state that an over-cap merge is rejected and that nothing is truncated

#### Scenario: The description discourages `title`

- **WHEN** the same description is inspected
- **THEN** it SHALL direct the model to send `title` only on the session's first curated write or when the stored title has stopped describing the work
- **AND** it SHALL state that omitting `title` keeps the stored one
- **AND** it SHALL NOT state or imply that `title` cannot be changed later

#### Scenario: The description carries no turn-report framing

- **WHEN** the same description is inspected
- **THEN** it SHALL NOT contain an instruction to summarise only the current context window, or to send a summary whose content is only the work of the latest turn

#### Scenario: The description stays under the client truncation ceiling

- **WHEN** every registered tool description is measured from a real `tools/list` response
- **THEN** `memory.session_summary`'s SHALL satisfy `DESCRIPTION_MAX_LENGTH`

#### Scenario: The description directs literal-copy of concrete facts, not paraphrase

- **WHEN** the `memory.session_summary` description is read from a real `tools/list` response
- **THEN** it SHALL instruct the model to copy carried-forward concrete facts (file paths with line numbers, measurements, test names, error strings) verbatim rather than paraphrase them
- **AND** it SHALL satisfy `DESCRIPTION_MAX_LENGTH`

### Requirement: The `instructions` block MUST state that a curated summary write replaces the stored value

`InitializeResult.instructions` is the only always-present surface on at least one client, re-injected into the system prompt every turn, so it is where a model that never reads a tool description still learns the protocol. Its `SUMMARIZE` line SHALL state that a curated write replaces the `##` sections it carries and KEEPS the ones it omits, that the summary to send is the current state, current first, and that its body uses exactly the six canonical `##` headings from `sessions`, each on its own line. Both halves of the first clause are required: the replacing half alone is the reading that makes a model retype a document it can no longer see.

The sentence stating that semantics SHALL come from ONE definition shared with the `memory.session_summary` description — a named constant exported alongside the canonical section list — so the two server-owned surfaces cannot drift into teaching different rules. A test SHALL assert that both carry it.

The complete line SHALL remain WITHIN the published 1000-character cap on both variants (see "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block"), and the cap SHALL NOT be raised for it. Two prior measurements stand: directly substituting the expanded canonical directive into the previously-binding 990-character variant produced 1113 characters, and the block measured 978 (unscoped) / 961 (scoped) immediately before the merge clause was added. Surrounding protocol prose SHALL be reclaimed rather than the cap moved, and the reclaim SHALL NOT drop a published SAVE, RECALL, session-id, scope, or update obligation — the block's opening line carries none of them and is the licensed source. Measured on the shipped text: a 59-character shared merge sentence with the opening line trimmed from 67 to 51 characters puts the unscoped variant at 977. The emitted scoped and unscoped strings, not a source estimate, are the authoritative measurements.

**The `title` guidance SHALL NOT be carried here.** It does not fit alongside the merge clause: a draft carrying both measured 1039 characters against the 1000-character cap. It lives in the `memory.session_summary` description alone, and this block SHALL continue to name `title` with its ≤100-character constraint so the session-close flow's published obligations remain satisfied.

The Hermes provider's `system_prompt_block()` is required elsewhere to stay byte-identical to this block's base text; that obligation is unchanged and means the clause lands in both or the pinning test fails.

#### Scenario: Both instruction variants carry the merge clause within the cap

- **WHEN** `buildInstructions` is rendered for a path-scoped connection and for `/mcp`
- **THEN** each output SHALL state that a curated write replaces the `##` sections it carries and keeps the ones it omits
- **AND** each SHALL ask for the current state, current first
- **AND** each SHALL require the exact canonical `##` headings on separate lines
- **AND** each SHALL be ≤1000 characters, with the cap unchanged

#### Scenario: The merge sentence has one source shared with the tool description

- **WHEN** the rendered `initialize.instructions` and the emitted `memory.session_summary` description are compared
- **THEN** both SHALL contain the same merge sentence, from the same exported constant
- **AND** neither SHALL state the merge rule in words the other does not carry

#### Scenario: The clause is mirrored in the client that does not consume the block

- **WHEN** the Hermes provider's system-prompt block is compared to the server's base instructions text
- **THEN** the two SHALL be byte-identical, so the clause is present in both
