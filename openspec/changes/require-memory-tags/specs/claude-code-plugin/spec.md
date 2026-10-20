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
