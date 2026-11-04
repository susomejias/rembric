## MODIFIED Requirements

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1500 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1500-character cap is therefore chosen for token cost, 548 characters below the known client ceiling, and it binds first. It was raised from 1000 to carry items 6 and 7 below — the obligations a connection with no host plugin depends on, because nothing else reminds it. The 2048-character ceiling is the figure verified in Claude Code 2.1.220; the constant was not located in the 2.1.318 binary when the cap was raised, so it is recorded as NOT re-verified there, and the 548-character margin is what absorbs that uncertainty. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect when nothing else resolved, and name `project.use` as the way to switch.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline, `content`, and `tags`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the optional `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Tag guidance SHALL teach normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`; selecting tags SHALL NOT require another tool call. The existing explicit-batch-tool requirements continue to govern operational judgment calls. The flow SHALL state that the save happens when the fact is settled rather than at the end, that one memory holds one fact, and that a session summary does not replace a saved memory. Mechanical detail (error codes, scope semantics, the hard 1–64 tag bound) MAY be deferred to the tool's own `description` and schema.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1500-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).
6. **The loop framing** — an opening line stating that only what the agent writes to Rembric outlives the conversation, and that the agent runs the RECALL → SAVE → SUMMARIZE loop itself rather than waiting for host reminders. A connection with no host plugin receives no turn notices at all, so this block is the whole protocol there; the RECALL, SAVE and SUMMARIZE lines SHALL appear in that order.
7. **The no-host session recovery** — `memory.session_summary` answers `session_not_found` on a transport no host registered a session for, so the block SHALL name the recovery: `memory.session_start` once, then retry.

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is bound to project `'my-project'`
- **AND** the note SHALL NOT contain `global`, `include_global` or `user-wide`
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before ending a working turn)
- **AND** the instructions SHALL contain the substring `10000` (the summary length cap)
- **AND** the instructions SHALL contain the substring `memory.context` (the recall flow)
- **AND** the instructions SHALL contain the substring `memory.about` (the update-guidance pointer)

#### Scenario: The session-summary trigger is bound to ending a working turn

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the instructions SHALL phrase the `memory.session_summary` trigger as firing before ending any turn in which real work happened
- **AND** the instructions SHALL NOT bind the trigger solely to the literal phrase `before saying "done"`

#### Scenario: Recall guidance is on-demand, not unconditional-at-start

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the `memory.context` recall flow SHALL be conditioned on the agent lacking prior detail (e.g. starting/resuming work, after `/compact`, or "what did we do")
- **AND** the instructions SHALL NOT direct an unconditional `memory.context` load on every session start

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note stating that a project is always active — naming the default project as the scope in effect, roots-based auto-detection where the client supports it, and `project.use` as the way to switch. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `packages/mcp/src/instructions.test.ts`, and SHALL NOT name `global`, `include_global` or user-wide memory.

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1500 characters or fewer (the 10000-char summary cap mention, the recall flow, the memory.about pointer, the loop framing AND the no-host recovery MUST all fit within the 1500-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `packages/mcp/src/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1500 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1500
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

#### Scenario: SAVE guidance teaches required useful tags

- **WHEN** either instructions variant is built
- **THEN** its SAVE clause SHALL include required `tags` and normally 1–5 useful reusable lowercase kebab-case labels, with examples `dashboard`, `sqlite`, and `bug-fix`
- **AND** `topic_key` SHALL remain optional and no extra tag-selection call SHALL be introduced

#### Scenario: A connection with no host plugin is taught the whole loop

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** its first line SHALL state that only what the agent writes outlives the conversation and that it SHALL NOT wait for host reminders
- **AND** its `RECALL:`, `SAVE:` and `SUMMARIZE:` lines SHALL appear in that order
- **AND** its `SAVE:` line SHALL contain `as soon as it is settled, not at the end`, `one fact per memory` and `A session summary never replaces it`
- **AND** it SHALL name `session_not_found` → `memory.session_start` once, then retry


### Requirement: The `instructions` block MUST state what a curated summary write replaces and what it keeps

`InitializeResult.instructions` is the only always-present surface on at least one client, re-injected into the system prompt every turn, so it is where a model that never reads a tool description still learns the protocol. Its `SUMMARIZE` line SHALL state that a curated write replaces the `##` sections it carries and KEEPS the ones it omits, that the summary to send is the current state, current first, and that its body uses exactly the six canonical `##` headings from `sessions`, each on its own line. Both halves of the first clause are required: the replacing half alone is the reading that makes a model retype a document it can no longer see.

The sentence stating that semantics SHALL come from ONE definition shared with the `memory.session_summary` description — a named constant exported alongside the canonical section list — so the two server-owned surfaces cannot drift into teaching different rules. A test SHALL assert that both carry it.

The complete line SHALL remain WITHIN the published `INSTRUCTIONS_MAX_LENGTH` cap on both variants (see "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block"), and the cap SHALL NOT be raised for it. The cap now stands at 1500; that raise carried the loop framing and the no-host recovery, not this line. Two prior measurements stand: directly substituting the expanded canonical directive into the previously-binding 990-character variant produced 1113 characters, and the block measured 978 (unscoped) / 961 (scoped) immediately before the merge clause was added. Surrounding protocol prose SHALL be reclaimed rather than the cap moved, and the reclaim SHALL NOT drop a published SAVE, RECALL, session-id, scope, or update obligation — the block's opening line carries none of them and is the licensed source. Measured on the shipped text: a 59-character shared merge sentence with the opening line trimmed from 67 to 51 characters puts the unscoped variant at 977. The emitted scoped and unscoped strings, not a source estimate, are the authoritative measurements.

**The `title` guidance SHALL NOT be carried here.** It does not fit alongside the merge clause: a draft carrying both measured 1039 characters against the 1000-character cap. It lives in the `memory.session_summary` description alone, and this block SHALL continue to name `title` with its ≤100-character constraint so the session-close flow's published obligations remain satisfied.

The Hermes provider's `system_prompt_block()` is required elsewhere to stay byte-identical to this block's base text; that obligation is unchanged and means the clause lands in both or the pinning test fails.

#### Scenario: Both instruction variants carry the merge clause within the cap

- **WHEN** `buildInstructions` is rendered for a path-scoped connection and for `/mcp`
- **THEN** each output SHALL state that a curated write replaces the `##` sections it carries and keeps the ones it omits
- **AND** each SHALL ask for the current state, current first
- **AND** each SHALL require the exact canonical `##` headings on separate lines
- **AND** each SHALL be within `INSTRUCTIONS_MAX_LENGTH`

#### Scenario: The merge sentence has one source shared with the tool description

- **WHEN** the rendered `initialize.instructions` and the emitted `memory.session_summary` description are compared
- **THEN** both SHALL contain the same merge sentence, from the same exported constant
- **AND** neither SHALL state the merge rule in words the other does not carry

#### Scenario: The clause is mirrored in the client that does not consume the block

- **WHEN** the Hermes provider's system-prompt block is compared to the server's base instructions text
- **THEN** the two SHALL be byte-identical, so the clause is present in both
