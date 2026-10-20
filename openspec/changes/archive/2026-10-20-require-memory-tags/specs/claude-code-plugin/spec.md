## MODIFIED Requirements

### Requirement: Each `/rembric:*` command body MUST name only arguments its tool's schema accepts

The four commands under `apps/plugin/commands/*.md` SHALL name only arguments accepted by their tools' schemas. They are agent-facing instructions: the model reads the body and issues the call verbatim. A command naming a parameter its tool does not accept produces a zod rejection at runtime, and a spec that documents such a call teaches the wrong shape to every reader.

The plugin SHALL ship exactly four commands under `/rembric:*`, auto-discovered from `apps/plugin/commands/*.md` (there is no `commands` field in `.claude-plugin/plugin.json`):

- `remember <text>` → `memory.save({type: 'project', title: <concise ≤100-char headline>, content: '$ARGUMENTS', tags: <useful reusable labels derived from the text>})`. The command SHALL direct the agent to supply the required headline and 1–64 tags, normally 1–5 lowercase kebab-case labels such as `dashboard`, `sqlite`, or `bug-fix`. `topic_key` remains optional. It SHALL NOT require an extra tool call to choose labels.
- `recall <topic>` → `memory.search({query: '$ARGUMENTS', limit: 5})`, rendered compactly. The parameter is `query`; `memorySearchSchema` has no `q`.
- `context` → `memory.context()`, rendered compactly. `contextSchema` accepts `sessions`, `prompts`, `memories`, `includeArchived` and `focus`; it has no `limit`.
- `summary` → `memory.session_summary({title, summary})`. `sessionSummarySchema` is `{sessionId?, summary (REQUIRED), title?}`; it has no `auto`, and a call omitting `summary` is rejected.

Every argument key named in a command body SHALL be a key of the corresponding tool's zod schema, and this SHALL be asserted in CI rather than reviewed by eye. The three wrong parameter names this requirement replaces (`q`, `limit` on `context`, `auto`) survived because the catalog was prose in an unexecuted section of the spec.

Each command's frontmatter `description` SHALL be ≤20 tokens; the four descriptions together with their `/rembric:<name>` prefixes SHALL be ≤80 tokens (see the token-budget requirement, which owns the always-on total and the measurement unit). Each command body SHALL be ≤3 lines.

#### Scenario: Every argument key exists in the tool's schema

- **WHEN** each file under `apps/plugin/commands/*.md` is parsed for `memory.<tool>({…})` call sites
- **THEN** every argument key named SHALL be a key of that tool's exported zod schema (`memorySearchSchema`, `contextSchema`, `sessionSummarySchema`, `memorySaveSchema`)
- **AND** the build SHALL fail when a key is not

#### Scenario: A renamed tool parameter breaks the build

- **GIVEN** a future change renames a schema key that a command body names
- **WHEN** the test suite runs
- **THEN** the command-argument assertion SHALL fail, naming the command file and the unknown key

#### Scenario: Frontmatter descriptions stay within budget

- **WHEN** each command's frontmatter `description` is measured in UTF-8 bytes
- **THEN** each SHALL be ≤80 bytes (≤20 tokens)
- **AND** the sum of `/rembric:<name> <description>` across all four SHALL be ≤320 bytes (≤80 tokens)

#### Scenario: Remember supplies required tags without another call

- **WHEN** the remember command is rendered for an agent
- **THEN** its save example SHALL include `tags` and teach normally 1–5 useful reusable lowercase kebab-case labels
- **AND** it SHALL stay within the existing command budgets and SHALL NOT introduce an extra tool call

### Requirement: The first prompt of a session MUST receive a relevance instruction

On the first user prompt of a session the plugin SHALL therefore emit a bounded, fixed instruction directing the model to call `memory.context` with `focus` set to that prompt before responding. The trigger SHALL fire at most once per session, tracked by its own per-session counter distinct from the per-turn nudge counter. The existing keyword trigger SHALL be retained for explicit recall requests at any point in the session, and both MAY fire on the same turn.

The recall hook fires a keyword-gated instruction only when the user's prompt matches a recall-intent keyword list. Without a second trigger, every other session would begin with no relevance signal at all, so whether the agent goes looking for prior knowledge would depend on the user's phrasing rather than on whether prior knowledge exists.

This is an **instruction to the model, not a server-side prefetch**. The hook SHALL make no HTTP request: the emitted text is fixed and byte-identical whether or not the scope contains any relevant memory, and the plugin performs no relevance query of its own. The consequence SHALL be recorded rather than implied — relevance injection depends on the model acting on the instruction, which a prefetch would not. A prefetch was considered and rejected FOR THIS HOOK: it would put an HTTP call on the first prompt of every session, on the latency-critical path, implemented in bash, to replace an instruction that works. Because this hook makes no request, there is no unreachable-server failure mode on this path.

Both statements are scoped to this capability's bash hooks and SHALL NOT be read as a four-client claim. The Hermes provider does implement a real prefetch — `queue_prefetch` in `apps/plugin/.hermes-plugin/__init__.py` POSTs `/memory/recall` and prepends the recalled text to the hint — so on that client the emitted block is corpus-dependent and does have a silent unreachable-server path. That divergence is deliberate: Hermes is an in-process Python provider with no bash latency budget and no per-client duplication cost. It is specified by `hermes-agent-plugin`, which this change does not audit; the two capabilities SHALL NOT be conflated, and a future four-client parity claim about relevance injection has to reconcile them first.

The emitted line SHALL be represented in the shared nudge fixtures with a byte budget asserted in lock-step against the equivalent line in every other client, so the four implementations cannot drift.

#### Scenario: A session with no recall keyword still receives a relevance instruction

- **GIVEN** a project with memories relevant to the user's first prompt
- **WHEN** the first prompt of a session contains no recall-intent keyword
- **THEN** the plugin SHALL emit the fixed first-prompt relevance line directing the model to call `memory.context` with `focus` set to the prompt

#### Scenario: The trigger does not repeat

- **WHEN** the second and subsequent prompts of the same session are submitted
- **THEN** the first-prompt line SHALL NOT be emitted again

#### Scenario: The emitted text does not depend on the corpus

- **GIVEN** two projects, one with many relevant memories and one with none
- **WHEN** the first prompt of a session is submitted in each, through this capability's `prompt-search.sh` hook
- **THEN** the emitted line SHALL be byte-identical in both cases
- **AND** this SHALL NOT be asserted of the Hermes provider, whose prefetch makes the block corpus-dependent by design

#### Scenario: The hook makes no network request

- **WHEN** `apps/plugin/scripts/prompt-search.sh` is inspected
- **THEN** it SHALL contain no call to `rembric_post` and no `curl` invocation
- **AND** it SHALL require neither `REMBRIC_SERVER_URL` nor `REMBRIC_API_TOKEN` to emit either line

#### Scenario: A broken counter does not fabricate a first turn

- **GIVEN** the first-prompt counter directory cannot be created or read back
- **WHEN** `UserPromptSubmit` fires
- **THEN** the first-prompt line SHALL NOT be emitted (fail closed), while the keyword trigger SHALL still be evaluated

#### Scenario: The injected line is fixture-covered

- **WHEN** the first-prompt line diverges from the equivalent line in another client, or exceeds its byte budget
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

### Requirement: All agent-facing text MUST be English and lock-step tested

Every string emitted to a model by the plugin SHALL be English. Each such string SHALL be represented in the shared nudge fixtures and asserted in lock-step against the equivalent string in every other client that emits it, **with its own individual byte budget** taken from the token-budget requirement's per-line table. One aggregate assertion SHALL NOT stand in for the individual ones: a single loose aggregate is how a 138-token block passed CI against a published `≤120` cap for its entire lifetime.

Agent-facing instruction text is a protocol surface, not user copy. It fires at the moment of highest consequence — for the post-compaction block, the model has just lost its context and this text is the only instruction telling it what to persist before continuing. A mid-conversation language switch degrades instruction-following and reliably causes the model to continue answering in that language, which is user-visible.

#### Scenario: The post-compaction block is English

- **WHEN** the post-compaction hook emits its protocol block
- **THEN** the emitted text SHALL be English

#### Scenario: The block is covered by the shared fixtures

- **WHEN** the post-compaction text diverges from the equivalent text in another client
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

#### Scenario: Every fixture string has an individual budget assertion

- **WHEN** `apps/plugin/test/nudge-fixtures.test.ts` is inspected
- **THEN** each agent-facing fixture SHALL carry its own byte-budget assertion matching the token-budget requirement's per-line table
- **AND** no fixture with an entry in that table SHALL be left without an assertion
