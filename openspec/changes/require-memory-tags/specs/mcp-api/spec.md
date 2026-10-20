## MODIFIED Requirements

### Requirement: memory.save MUST accept a `topic_key` and surface candidates

The `memory.save` tool's input schema SHALL require a `title: string` argument (1–100 chars; empty or over-long rejected with `invalid_input`) and `tags: string[]` containing 1–64 strings, and SHALL accept an optional `topic_key?: string` argument (max length 128, NUL-byte rejected). The response shape SHALL include `candidates: Array<Candidate>` (always present, empty when none found) and `judgmentRequired: boolean`. Existing fields (`id`, `status`, `createdAt`) are unchanged. Later additive response requirements, including `candidatesDetected` and candidate entity/source refinements, continue to apply; the response examples below are projections, not exhaustive schemas.

The `Candidate` type:

```ts
{
  judgmentId: string;
  targetId: string;
  title: string; // the candidate's title
  snippet: string; // first ~200 chars of the candidate's content
  similarity: number; // 0..1, max(vec, fts) normalized
  source: 'vec' | 'fts'; // which detector surfaced it
}
```

#### Scenario: memory.save with no `topic_key` and zero candidates

- **WHEN** `memory.save({type, title, content, tags: ['dashboard']})` is called and no existing memory matches the candidate-detection thresholds
- **THEN** the response SHALL include `{ id, status: 'active', createdAt, candidates: [], judgmentRequired: false }`
- **AND** omitting `topic_key` SHALL remain valid

#### Scenario: memory.save without a title

- **WHEN** `memory.save` is called without a `title`, or with a `title` that is empty or longer than 100 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

#### Scenario: memory.save with `topic_key` upserting an existing row

- **WHEN** `memory.save({type, title, content, tags: ['auth'], topic_key: 'arch/auth'})` is called and an active memory with that key exists in scope
- **THEN** the response SHALL include the newly created `id`; the previous row SHALL be in `status = 'superseded'`; `candidates` MAY additionally include unrelated rows surfaced by FTS/vec; `judgmentRequired` reflects only the candidates surfaced via that path, not the topic-key upsert (which is already judged)

#### Scenario: memory.save before the just-saved row has an embedding

- **GIVEN** the just-saved row's embedding has not been computed yet (lazy model load or worker lag)
- **WHEN** `memory.save` finds three FTS5 matches above threshold
- **THEN** the response SHALL include three candidates each with `source: 'fts'` and each carrying the candidate's `title`; no vec-sourced candidates SHALL appear

#### Scenario: memory.save with `topic_key` longer than 128 chars

- **WHEN** the input `topic_key` exceeds 128 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

### Requirement: `memory.capture_passive` MUST use the same curation path as `memory.save`

`memory.capture_passive` is the tool the protocol steers agents toward for bulk persistence, so it SHALL NOT be a weaker write path. Its input SHALL require batch-level `tags: string[]` containing 1–64 strings, alongside `text: string` and optional `sessionId: string`. Each extracted learning SHALL receive the supplied batch tags and SHALL be saved through the same pipeline as `memory.save`: service-boundary tag normalization and validation before any transaction, convergent-topic handling, inline embedding before candidate detection, and save-time candidate detection. The response SHALL aggregate the detected `candidates[]` so conflicts introduced by a bulk capture are surfaceable and judgeable, rather than silently accumulating unlinked rows that are additionally invisible to the dense search branch until a background drain reaches them.

This required-tag contract supersedes the tagless `{ text: string, sessionId?: string }` shorthand in "The MCP server MUST expose three research tools". That requirement's extraction rules, reference type, scope behavior, and context/timeline contracts are otherwise unchanged. Its no-learnings success scenario presupposes valid required tags; missing or structurally invalid tags SHALL be rejected even when text contains no learning block. Existing additive response requirements, including `candidatesDetected`, remain in force.

#### Scenario: A bulk capture surfaces a conflict

- **GIVEN** an existing active memory that semantically conflicts with one of the extracted learnings
- **WHEN** `memory.capture_passive` saves that learning with valid batch tags
- **THEN** the response SHALL include a candidate referencing the existing memory, and a pending relation SHALL have been recorded

#### Scenario: Captured rows are immediately searchable by the dense branch

- **WHEN** `memory.capture_passive` saves a learning with valid batch tags
- **THEN** that row's embedding SHALL have been computed before the call returns, so a subsequent `memory.search` vector branch can surface it

#### Scenario: Batch tags reach every learning and normalize once at the shared boundary

- **WHEN** a valid capture request contains two extracted learnings and `tags: [' Dashboard ', 'Deploy / Docker', 'deploy_docker']`
- **THEN** each persisted memory SHALL have `['dashboard', 'deploy-docker']` in that order
- **AND** no inference call or per-learning tag-selection call SHALL be required

#### Scenario: Invalid supplied tags prevent capture writes

- **WHEN** a capture containing multiple learnings supplies a NUL-containing tag or a tag yielding no Unicode word runs, each case tested separately
- **THEN** it SHALL fail with `invalid_input` naming `tags` before saving the first learning
- **AND** it SHALL create no memory or relation rows

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect when nothing else resolved, and name `project.use` as the way to switch.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline, `content`, and `tags`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the optional `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Tag guidance SHALL teach normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`; selecting tags SHALL NOT require another tool call. The existing explicit-batch-tool requirements continue to govern operational judgment calls. Mechanical detail (error codes, scope semantics, the hard 1–64 tag bound) MAY be deferred to the tool's own `description` and schema.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

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
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
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
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

#### Scenario: SAVE guidance teaches required useful tags

- **WHEN** either instructions variant is built
- **THEN** its SAVE clause SHALL include required `tags` and normally 1–5 useful reusable lowercase kebab-case labels, with examples `dashboard`, `sqlite`, and `bug-fix`
- **AND** `topic_key` SHALL remain optional and no extra tag-selection call SHALL be introduced

## ADDED Requirements

### Requirement: Operational memory writes MUST advertise and enforce required tag arrays

The operational MCP input schemas for `memory.save` and `memory.capture_passive` SHALL require `tags` as an array of 1–64 strings. The count bound applies to supplied elements before normalization/deduplication. Both SHALL expose this bound and useful-label guidance through their JSON input schemas; `capturePassiveSchema.tags` SHALL reuse the existing `memorySaveSchema.tags` field without a new schema module or Zod transforms. Canonicalization and semantic-empty/NUL rejection SHALL occur at the shared service save boundary as specified by `memory`.

The tag contract in this requirement and the updated shared-curation requirement takes precedence over older abbreviated save/capture examples that omit tags, including the research-tools capture signature. Other request/response fields and behaviors remain governed by their existing requirements. The sentence "request and response shapes themselves are unchanged" in the protocol-teaching-description requirement SHALL NOT override this explicit required-tag change. `topic_key` remains optional. This contract SHALL NOT apply to `memory.save_prompt`, internal seed/evaluation inputs, historical reads, or change `memory.context` payloads/defaults/limits. No new tool, catalog, alias, semantic merge, or extra call is introduced.

#### Scenario: tools/list exposes both tag contracts

- **WHEN** an MCP client retrieves `tools/list`
- **THEN** each of `memory.save` and `memory.capture_passive` SHALL list `tags` in `inputSchema.required`, with an array of strings, `minItems: 1`, `maxItems: 64`, and a property description teaching useful reusable lowercase kebab-case labels, normally 1–5 (for example `dashboard`, `sqlite`, `bug-fix`)
- **AND** their existing tool descriptions SHALL teach that tags are required while remaining within the existing description ceiling

#### Scenario: Missing or structurally invalid tags are rejected at the wire boundary

- **WHEN** each tool is called through MCP transport with otherwise valid arguments and omitted tags, `[]`, 65 elements, a non-array, or a non-string element, each case tested separately
- **THEN** the SDK SHALL reject the arguments before the handler runs and no memory or relation SHALL be written
- **AND** the controls using 1 and 64 valid tags SHALL succeed for both tools
- **AND** capture's required-array checks SHALL also apply when text contains no learnings

#### Scenario: Noncanonical valid labels normalize rather than failing schema validation

- **WHEN** either tool receives otherwise valid input with `tags: [' Dashboard ', 'Deploy / Docker', 'deploy_docker', 'autenticación', '部署']`
- **THEN** schema validation SHALL accept it and each saved memory SHALL persist `['dashboard', 'deploy-docker', 'autenticación', '部署']`
- **AND** an otherwise valid request containing a NUL or empty-after-normalization tag SHALL return the service's `invalid_input` error before writes

#### Scenario: Context and prompt tags stay unchanged

- **WHEN** existing context reads and prompt saves are exercised after the tag change
- **THEN** `memory.context` SHALL retain its existing response fields, defaults, and limits without a tag catalog or larger payload contract
- **AND** `memory.save_prompt` SHALL retain its existing optional-tag semantics without memory-tag normalization
