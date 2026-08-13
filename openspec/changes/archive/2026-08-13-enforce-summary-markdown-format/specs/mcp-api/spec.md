## MODIFIED Requirements

### Requirement: The `memory.session_summary` description MUST state that the write replaces the stored summary and ask for the current complete state

The tool's own description is the longest text a model reads about this tool before calling it, and it is the surface every client reaches — including the one that discovers tools with `tools/list` rather than enumerating them. It SHALL therefore carry the write's semantics, not only its arguments. The description SHALL state, in its own words but with all six facts present:

1. **That the write REPLACES the stored summary.** A model that believes the server accumulates will send a delta, and the delta is what gets stored.
2. **That the summary asked for is the session's CURRENT COMPLETE state**, concise rather than exhaustive — the state that holds now for the whole session, not the work of the current context window.
3. **That the current state goes FIRST.** The reason SHALL be given, because a bare ordering instruction reads as a style rule and is the first thing a model drops under length pressure: `memory.context` shows only the beginning of a stored summary, so the opening lines are the preview a later session sees, and the full text is available only to a model that calls `memory.session_get`.
4. **That a model which cannot see its earlier work SHALL read the stored summary first** via `memory.session_get`, rather than write only what its window still holds.
5. **That carried-forward facts SHALL be copied, not paraphrased.** File paths with line numbers, measurements, test names and error strings SHALL be copied verbatim from what the model already knows into the new summary text, rather than restated in its own words — a rephrased number is a lost number, because a later reader (human or model) can `grep` a copied fact but not a paraphrase of it.
6. **That the body uses the canonical Markdown structure.** It SHALL name exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`, and SHALL state that each level-2 heading belongs on its own line rather than in one flat paragraph.

The description SHALL NOT instruct the model to "add what's new", to send only what changed, or to summarise the current window — any of which makes the stored summary the delta.

These obligations SHALL be discharged in the top-level description text, not only in a per-argument zod `describe()`, and SHALL be satisfied within `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"). The cap SHALL NOT be raised to accommodate them: the description measured 670 characters against a 1900-character ceiling before this requirement, so the four facts fit with room to spare, and if that ever ceases to be true prose is cut instead. Fact 5 above landed after the other four had already brought the description to 1003 characters; carrying the first five facts measured 1175 characters. Adding the canonical heading directive measures approximately 1298 characters, still comfortably within the 1900-character ceiling; the emitted `tools/list` value is the authoritative measurement.

Two published statements about this tool remain true verbatim and SHALL NOT be weakened by this requirement. The published scenario titled _`memory.session_summary` may be called multiple times; the latest call wins_ continues to describe the column's outcome — the replacement is retained by design and only its destructiveness is removed (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"). And the tool keeps `idempotentHint: true` under "Every MCP tool MUST advertise behavioral annotations", because a byte-identical repeat appends no version row and therefore still has no additional effect.

#### Scenario: The description names replacement and the current-state obligation

- **WHEN** the `memory.session_summary` description is read from a real `tools/list` response
- **THEN** it SHALL state that the write replaces the stored summary
- **AND** it SHALL ask for the current complete state of the session rather than for recent or new work
- **AND** it SHALL state that the current state comes first, with the reason that only the beginning is shown in `memory.context`
- **AND** it SHALL name `memory.session_get` as the way to read what is stored before rewriting it
- **AND** it SHALL require the six canonical `##` headings on separate lines

#### Scenario: The description carries no delta framing

- **WHEN** the same description is inspected
- **THEN** it SHALL NOT contain an instruction to add only what is new, to send only what changed, or to summarise only the current context window

#### Scenario: The description stays under the client truncation ceiling

- **WHEN** every registered tool description is measured from a real `tools/list` response
- **THEN** `memory.session_summary`'s SHALL satisfy `DESCRIPTION_MAX_LENGTH`

#### Scenario: The description directs literal-copy of concrete facts, not paraphrase

- **WHEN** the `memory.session_summary` description is read from a real `tools/list` response
- **THEN** it SHALL instruct the model to copy carried-forward concrete facts (file paths with line numbers, measurements, test names, error strings) verbatim rather than paraphrase them
- **AND** it SHALL satisfy `DESCRIPTION_MAX_LENGTH`

### Requirement: The `instructions` block MUST state that a curated summary write replaces the stored value

`InitializeResult.instructions` is the only always-present surface on at least one client, re-injected into the system prompt every turn, so it is where a model that never reads a tool description still learns the protocol. Its `SUMMARIZE` line SHALL state that the write replaces the stored summary, that the summary to send is the current state whole and current first, and that its body uses exactly the six canonical `##` headings from `sessions`, each on its own line.

The complete line SHALL remain WITHIN the published 1000-character cap on both variants (see "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block"), and the cap SHALL NOT be raised for it. Directly substituting the expanded canonical directive into the previously-binding 990-character variant produces 1113 characters, so surrounding protocol prose SHALL be reclaimed without dropping a published SAVE, RECALL, session-id, scope, or update obligation. The emitted scoped and unscoped strings, not a source estimate, are the authoritative measurements.

The Hermes provider's `system_prompt_block()` is required elsewhere to stay byte-identical to this block's base text; that obligation is unchanged and means the clause lands in both or the pinning test fails.

#### Scenario: Both instruction variants carry the replacement clause within the cap

- **WHEN** `buildInstructions` is rendered for a path-scoped connection and for `/mcp`
- **THEN** each output SHALL state that a curated summary write replaces the stored value and SHALL ask for the current state whole, current first
- **AND** each SHALL require the exact canonical `##` headings on separate lines
- **AND** each SHALL be ≤1000 characters

#### Scenario: The clause is mirrored in the client that does not consume the block

- **WHEN** the Hermes provider's system-prompt block is compared to the server's base instructions text
- **THEN** the two SHALL be byte-identical, so the clause is present in both
