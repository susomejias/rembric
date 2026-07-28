## MODIFIED Requirements

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline plus the `content`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Mechanical detail (error codes, scope semantics) MAY be deferred to the tool's own `description`.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is project-scoped to `'my-project'` and that `scope='global'` will be rejected
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
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note indicating the connection is global-scope and that project memories require opening `/mcp/<slug>` or sending `X-Rembric-Project`

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, scope notes, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked
