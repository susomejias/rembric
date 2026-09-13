## MODIFIED Requirements

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged. In addition, the `memory.search` description SHALL advertise that results are ranked by hybrid semantic + keyword relevance (vector similarity combined with FTS5) — so the agent knows paraphrases and cross-lingual queries match, not only exact keywords — and SHALL advertise the result-page affordance: results are a small default page that can be widened by passing a larger `limit` or paged with `offset` when more relevant results are needed. These additions SHALL NOT remove or weaken the recall trigger.

The `memory.search` description's trigger list SHALL include proactive recall moments: before starting work in an area untouched this session, before diagnosing a possibly-known error, and before building something that may already exist. The trigger list SHALL ALSO include the existing reactive triggers (the user referencing past work or asking to recall). The two categories are complementary, not replacements.

The `memory.search` description SHALL additionally name the shortening flag and say what a short page does and does not imply: that the corpus is not necessarily exhausted. Ranked retrieval returns the best available rows whether or not any of them is relevant, so the description SHALL also state that a full page is not evidence that its rows are relevant. That sentence is the only mitigation available at the description layer for a ranked branch with no absolute relevance threshold, and it is required for the same reason the anti-confabulation instruction is.

Every content obligation in this requirement SHALL be satisfied within `DESCRIPTION_MAX_LENGTH`. Where a new obligation cannot fit, text SHALL be reclaimed from clauses no requirement mandates, and the reclaimed clause SHALL be named in the change that removes it — not appended past the cap, and not paid for by raising the cap.

**The clauses this change reclaimed to fund the proactive triggers are named here, as that rule requires.** Three were removed from `memory.search`'s description, none of them mandated by any requirement in this capability:

- `Answers "what do I know about this file/error/host"` — a restatement of what the `entity` argument does, already carried by the sentence that introduces it.
- `or when the answer is not expected in this project` — a second illustration of when `across_projects` is warranted, alongside the "only on an explicit ask" clause that survives and carries the obligation.
- `before saving with a new key` — the motive for the `topic_key` history filter, where the filter's own description already states that it returns the topic's whole history.

The measured result is 1873 of 1900 characters, 27 remaining, pinned by an exact-length assertion against a real `tools/list` response rather than a `String.length` on the constant.

#### Scenario: `memory.save` description teaches the trigger list

- **WHEN** an MCP client retrieves the tool description for `memory.save` via `tools/list`
- **THEN** the description SHALL contain the substring `Call this IMMEDIATELY after` followed by a list including at least: bug fix, decision, discovery, configuration change, pattern, user preference

#### Scenario: `memory.search` description teaches when to call

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it whenever the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description teaches proactive recall moments

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it before starting work in an area untouched this session, before diagnosing a possibly-known error, and before building something that may already exist
- **AND** the description SHALL ALSO contain wording instructing the agent to call it when the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description advertises hybrid ranking and the widen affordance

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL convey that ranking is hybrid semantic + keyword (so paraphrases / cross-lingual queries match), and SHALL convey that the default result page is small and can be widened via `limit` or paged via `offset`
- **AND** the description SHALL still contain both the proactive and reactive recall trigger wording from the prior scenario

#### Scenario: `memory.search` description explains a short page and a full one

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL name the shortening flag, SHALL state that a short page does not mean the corpus is exhausted, and SHALL state that a full page is not proof that its rows are relevant

#### Scenario: A reworded description is still within the cap

- **WHEN** the `memory.search` description is changed to satisfy a new content obligation
- **THEN** its `String.length` measured from a real `tools/list` response SHALL remain at or below `DESCRIPTION_MAX_LENGTH`, and the change SHALL record the measured length and the remaining headroom

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect when nothing else resolved, and name `project.use` as the way to switch.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline plus the `content`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Mechanical detail (error codes, scope semantics) MAY be deferred to the tool's own `description`.
2. **A recall flow** — directing the agent to call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The trigger list SHALL name proactive moments — before starting work in an area untouched this session, before diagnosing a possibly-known error, before building something that may already exist — AND SHALL keep a reactive trigger for an explicit request to recall. Naming both categories is the obligation; the specific illustrations of each are wording, not contract. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

**Every component in that list SHALL carry its own assertion.** The list is the whole point of the requirement, and a component with no test is a component that leaves silently: this change's own rewrite of the block dropped component 5 to make room for the new recall wording, no test named it before or after, and the loss surfaced only when a later reader diffed the block against `main`. A length test plus substring checks for a subset is not coverage of an enumerated list, and the enumeration SHALL NOT be trusted to survive a rewrite that no assertion defends. Where a component's presence is checked by substring, the substring SHALL be one the component cannot lose while still satisfying its own description.

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is bound to project `'my-project'`
- **AND** the note SHALL NOT contain `global`, `include_global` or `user-wide`
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before ending a working turn)
- **AND** the instructions SHALL contain the substring `10000` (the summary length cap)
- **AND** the instructions SHALL contain the substring `memory.context` (the recall flow)
- **AND** the instructions SHALL contain the substring `memory.about` (the update-guidance pointer)

#### Scenario: Every enumerated component is asserted, including the `sessionId` clause

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** a test SHALL assert the presence of each of the five enumerated components individually
- **AND** the assertion for component 5 SHALL fail if the block stops directing the agent to pass a known session id and to never invent one
- **AND** each assertion SHALL be separate, so one missing component is attributable to one component rather than to a single aggregate check

#### Scenario: The recall flow names both trigger categories

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the recall flow SHALL name at least one proactive moment at which to recall before acting
- **AND** it SHALL name a reactive trigger for an explicit request to recall
- **AND** removing either category SHALL fail an assertion

#### Scenario: The session-summary trigger is bound to ending a working turn

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the instructions SHALL phrase the `memory.session_summary` trigger as firing before ending any turn in which real work happened
- **AND** the instructions SHALL NOT bind the trigger solely to the literal phrase `before saying "done"`

#### Scenario: Recall guidance is on-demand, not unconditional-at-start

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the `memory.context` recall flow SHALL be conditioned on the agent lacking prior detail
- **AND** the instructions SHALL NOT direct an unconditional `memory.context` load on every session start

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note stating that a project is always active — naming the default project as the scope in effect, roots-based auto-detection where the client supports it, and `project.use` as the way to switch. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `apps/server/src/mcp/instructions.test.ts`, and SHALL NOT name `global`, `include_global` or user-wide memory.

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: The block carries no whitespace-only line

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** no line SHALL consist solely of whitespace
- **AND** this SHALL be asserted, because such a line is invisible in review, costs tokens on every connection, and reached production once through a template-literal edit

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

## ADDED Requirements

### Requirement: A dedicated recall-hints endpoint MUST extract entities from the prompt and return proactive recall lines synchronously

A new endpoint `POST /api/<slug>/sessions/:id/recall-hints` SHALL accept `{prompt: string}`, extract entities from the first 500 characters of the prompt using the existing `extractEntities()` function, match each entity against the entity index via `repos.entities.findMemoriesByEntity()`, and return `{lines: string[]}`.

The endpoint SHALL be read-only with respect to persistence: the prompt SHALL NOT be written to any table, index, or log at `info` level or above. Entity extraction SHALL be scoped to the connection's project via `projectScope()`.

The endpoint SHALL return an empty `lines` array when the prompt contains no extractable entities or when no matched memories pass the active-learning-type filter (`type IN ('project', 'feedback', 'procedural')`). The endpoint SHALL NOT fail when the session has no prior recall state; it SHALL simply return no lines.

#### Scenario: A prompt mentioning a file entity returns a recall line

- **GIVEN** a session with memories whose entities include the file path `src/auth/handler.ts`
- **WHEN** the recall-hints endpoint receives `prompt: "Fix the login flow in src/auth/handler.ts"`
- **THEN** the response SHALL contain `{lines: [...]}` with at least one line naming the matched memory's title

#### Scenario: A prompt with no entities returns empty lines

- **WHEN** the recall-hints endpoint receives `prompt: "Do it"`
- **THEN** the response SHALL contain `{lines: []}`

#### Scenario: The prompt is never persisted

- **WHEN** the recall-hints endpoint processes a request with a `prompt` field
- **THEN** no row SHALL be inserted into `memory`, `prompts`, `agent_sessions`, `consolidation_ops`, or any other table for the prompt text
- **AND** the prompt SHALL NOT appear in any log output at `info` level or above (debug-level tracing MAY include it for diagnostics)

#### Scenario: The endpoint is optional for clients

- **WHEN** a client does not call the recall-hints endpoint
- **THEN** the turn-report endpoint SHALL continue to function as before (no behavioral change to the turn channel)

#### Scenario: A missing session returns an error

- **WHEN** the recall-hints endpoint receives a session id that does not exist
- **THEN** the server SHALL return an appropriate error status (e.g. 404) and SHALL NOT compose any recall lines
