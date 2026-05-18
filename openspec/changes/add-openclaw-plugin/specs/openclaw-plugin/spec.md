## ADDED Requirements

### Requirement: Native OpenClaw plugin manifest at `plugin/.openclaw-plugin/openclaw.plugin.json`

The repository SHALL host a native OpenClaw plugin manifest at `plugin/.openclaw-plugin/openclaw.plugin.json`, sibling to the existing per-client manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`). The manifest SHALL declare Rembric as a memory-provider plugin and SHALL be the canonical entry point for `openclaw plugins install`.

#### Scenario: Required manifest fields

- **WHEN** `plugin/.openclaw-plugin/openclaw.plugin.json` is loaded
- **THEN** the top-level object SHALL contain `id: "rembric"`, `kind: "memory"`, a `version` string, a `description`, and an `activation` block declaring `onStartup: true`
- **AND** the manifest SHALL declare `contracts.tools` listing every memory tool the plugin registers (mirroring the MCP tool surface: `memory_save`, `memory_search`, `memory_get`, `memory_judge`, `memory_confirm`, `memory_compare`, `memory_context`, `memory_timeline`, `memory_stats`, `memory_session_start`, `memory_session_end`, `memory_session_summary`, `memory_save_prompt`, `memory_capture_passive`, `project_current`, `project_list`, `project_use`)

#### Scenario: `configSchema` declares user-configurable fields

- **WHEN** the manifest is loaded
- **THEN** `configSchema` SHALL be a JSON Schema object with `type: "object"` declaring at least these properties:
  - `server_url` (string, required) — Rembric server base URL without `/mcp` suffix
  - `api_token` (string, required) — Rembric bearer token from `/dashboard/tokens`
  - `autoRecall` (boolean, default `true`) — whether the typed `before_prompt_build` hook auto-injects memories
  - `autoCapture` (boolean, default `false`) — whether `agent_end` auto-writes a memory
  - `tokenBudget` (number, default documented) — token budget for the auto-recall section
- **AND** `configSchema.additionalProperties` SHALL be `false` so unknown fields are rejected

#### Scenario: `configContracts.secretInputs` covers the API token

- **WHEN** the manifest is loaded
- **THEN** `configContracts.secretInputs.paths` SHALL contain an entry for `api_token` so OpenClaw treats the value as secret (sensitive logging, keychain-backed storage where OpenClaw supports it)
- **AND** `uiHints.api_token` SHALL declare `sensitive: true` with a placeholder of the form `"rbr_..."`
- **AND** `uiHints.server_url` SHALL declare a placeholder of the form `"https://memory.example.com"` (no `/mcp` suffix)

#### Scenario: Manifest is the only client divergence point inside `plugin/.openclaw-plugin/`

- **WHEN** the repository is at HEAD
- **THEN** `plugin/.openclaw-plugin/` SHALL NOT contain a `.mcp.json`, a `hooks.json`, or any other Claude/Codex-style bundle marker
- **AND** OpenClaw SHALL identify the plugin via the native manifest (not via Codex/Claude bundle detection)

### Requirement: Plugin entry point registers tools, hooks, memory capability, auto-recall, and guardrails programmatically

The plugin SHALL provide a plain ESM `.mjs` entry point at `plugin/.openclaw-plugin/plugin.mjs` that exports a `register(api)` function (or the default export the OpenClaw host expects — confirmed at implementation against the agentmemory reference). The entry SHALL register all integration surfaces via the `OpenClawPluginApi` instance the host injects. The entry SHALL NOT rely on file-based hook discovery (`HOOK.md + handler.ts`), Claude-style `hooks.json`, or Codex-style hook layouts — those are not executed by OpenClaw for native plugins. The entry SHALL NOT depend on `@openclaw/plugin-sdk` as an installed npm package (the SDK ships as `workspace:*` only and is not resolvable from outside the OpenClaw monorepo).

#### Scenario: Tool registration mirrors the MCP tool surface

- **WHEN** the plugin's `register(api)` runs
- **THEN** every tool listed in `contracts.tools` SHALL be registered via `api.registerTool(tool, opts?)`
- **AND** each tool handler SHALL forward its arguments through `src/http-client.ts` to the corresponding Rembric MCP HTTP endpoint (or HTTP API endpoint for session-lifecycle tools)
- **AND** tool responses SHALL surface the same fields the MCP tool returns (including `candidates[]` from `memory_save` so the agent can call `memory_judge` afterwards)

#### Scenario: Session lifecycle hooks POST to the existing HTTP API

- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.on('session_start', handler)`, `api.on('session_end', handler)`, `api.on('before_compaction', handler)`, and `api.on('after_compaction', handler)` SHALL each be wired
- **AND** the `session_start` handler SHALL POST `{ id, cwd?, agent: 'openclaw', description? }` to `/api/<slug>/sessions`
- **AND** the `session_end` handler SHALL POST `{ summary, title?, final?: true }` to `/api/<slug>/sessions/<id>/end`
- **AND** the `before_compaction` and `after_compaction` handlers SHALL POST per-turn summary updates to `/api/<slug>/sessions/<id>/summary` (with `final: false`) matching Codex's per-turn semantics
- **AND** the slug used by each handler SHALL come from `${cwd}/.rembric::PROJECT_SLUG` if readable, otherwise omitted (the server falls back to global scope per `http-api`)

#### Scenario: Interactive handler matches the recall trigger phrases

- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.registerInteractiveHandler({ pattern, handler })` SHALL be called with a pattern matching the regex `remember|recall|acordate|qué hicimos|what did we do` (case-insensitive)
- **AND** when the user prompt matches, the handler SHALL call `memory.search` against the Rembric MCP HTTP transport with the user's prompt as the query
- **AND** the handler SHALL inject the returned memories into the prompt via the contract the SDK provides for interactive-handler context return values

#### Scenario: Memory capability claims the OpenClaw memory slot

- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.registerMemoryCapability(capability)` SHALL be called with a capability object exposing the recall/store/list adapters required by OpenClaw's memory-slot contract (consult `/tmp/openclaw/src/plugins/types.ts` at implementation; the capability adapters MUST resolve through the HTTP client, not a local cache)
- **AND** when `~/.openclaw/openclaw.json::plugins.slots.memory !== 'rembric'`, the plugin SHALL emit a structured warning via `api.logger` indicating that another plugin owns the slot and Rembric's auto-recall integration is inactive

#### Scenario: Auto-recall hook is registered when `autoRecall: true`

- **GIVEN** the user's config has `autoRecall: true` (the default)
- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.on('before_prompt_build', handler)` SHALL be called with a handler that queries `memory.search` against the current prompt and returns `{ prependContext }` sized to `tokenBudget`
- **AND** `api.registerMemoryPromptSection` SHALL NOT be used for async recall because OpenClaw's memory prompt-section builder is synchronous and only accepts `string[]`
- **AND** when `autoRecall: false`, the `before_prompt_build` auto-recall hook SHALL NOT be registered

#### Scenario: Memory-file writes are blocked when Rembric owns memory

- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.on('before_tool_call', handler)` SHALL be called
- **AND** when a file-editing tool call targets OpenClaw's file-backed memory paths (`MEMORY.md` or `memory/*.md`), the handler SHALL return `{ block: true, blockReason }`
- **AND** the block reason SHALL instruct the agent to call `memory_save` instead, so durable writes go to Rembric rather than OpenClaw's local memory files
- **AND** Rembric's own `memory_*` tools SHALL NOT be blocked by this guard

#### Scenario: Auto-capture is off by default

- **GIVEN** the user's config has `autoCapture` unset OR `autoCapture: false`
- **WHEN** an `agent_end` event fires
- **THEN** the plugin SHALL NOT POST any memory save
- **AND** the only effect of `agent_end` SHALL be the session-end POST described in the lifecycle-hooks scenario

#### Scenario: Slash command `/rembric` registers via `registerCommand`

- **WHEN** the plugin's `register(api)` runs
- **THEN** `api.registerCommand({ name: 'rembric', ... })` SHALL be called with a command that surfaces operator-friendly subcommands (at minimum: `status` to show config + active session + slot ownership; further subcommands MAY be added without spec amendment as long as they wrap existing tools)

### Requirement: HTTP client reimplements POSTs natively in plain ESM JavaScript

The plugin SHALL include an HTTP client at `plugin/.openclaw-plugin/http-client.mjs` (or co-located inside `plugin.mjs` if the total surface stays small — module split is an implementation detail) that POSTs to the Rembric server using `fetch`. The client SHALL NOT shell out to `plugin/scripts/_api.sh` or any other bash script — those scripts remain Claude/Codex specific.

#### Scenario: Client uses `api.pluginConfig` for credentials

- **WHEN** the HTTP client constructs a request
- **THEN** the `Authorization: Bearer <token>` header SHALL be sourced from `api.pluginConfig.api_token` (or whatever access pattern the SDK provides for secret config values)
- **AND** the request URL SHALL be built by joining `api.pluginConfig.server_url` with the endpoint path
- **AND** credentials SHALL NOT be read from `process.env`

#### Scenario: Client matches the HTTP API contract

- **WHEN** the client POSTs to a session-lifecycle endpoint
- **THEN** the request body SHALL match the schema required by the `http-api` capability (request fields, length limits, regex constraints)
- **AND** error responses SHALL be surfaced to the caller using their `{ ok: false, code, message }` shape

#### Scenario: Client failures are non-fatal

- **WHEN** a POST fails (network error, 5xx, timeout)
- **THEN** the handler SHALL log the error via `api.logger` and SHALL NOT throw out of the hook — host stability is more important than POST success
- **AND** subsequent hook invocations SHALL retry independently (no global error latch)

### Requirement: Plugin ships as hand-authored ESM with no build step

The plugin SHALL ship as hand-authored ESM JavaScript files directly under `plugin/.openclaw-plugin/`. There SHALL be no `tsconfig.json`, no `tsdown.config.*`, no `dist/` directory, and no committed build artifacts inside the OpenClaw sub-tree. The OpenClaw plugin SDK is not installable outside the OpenClaw monorepo (`@openclaw/plugin-sdk` is a `workspace:*` package); the runtime API is injected by the host at plugin load time. This decision is documented with full rationale in the change's `design.md::Decision 3`.

#### Scenario: Entry file is plain ESM

- **WHEN** the repository is at HEAD on the branch that landed this change
- **THEN** `plugin/.openclaw-plugin/plugin.mjs` SHALL exist and be a runnable ESM module
- **AND** `plugin/.openclaw-plugin/package.json::openclaw.extensions` SHALL contain the entry `./plugin.mjs`
- **AND** the file SHALL NOT contain any TypeScript-specific syntax (no type annotations, no `as` assertions, no `interface` declarations)

#### Scenario: No build pipeline ships under the OpenClaw sub-tree

- **WHEN** the repository is inspected at `plugin/.openclaw-plugin/`
- **THEN** there SHALL be no `tsconfig.json`, no `tsdown.config.ts`, no `tsdown.config.mjs`, no `dist/` directory, and no `.ts` source files
- **AND** `package.json::scripts` SHALL NOT contain a `build` script — there is nothing to build
- **AND** the manifest entry path resolved by OpenClaw SHALL point at the `.mjs` file directly

#### Scenario: ESLint covers the new files

- **WHEN** `pnpm run lint` runs at the repo root
- **THEN** the new `.mjs` files SHALL be linted by the repository's existing ESLint config (the root `lint-staged` already targets `*.mjs`)
- **AND** lint errors in the new files SHALL fail the lint command

#### Scenario: Vitest covers the new tests

- **WHEN** `pnpm test` runs at the repo root
- **THEN** the co-located `*.test.mjs` files under `plugin/.openclaw-plugin/` SHALL be discovered and executed by Vitest
- **AND** failures SHALL block the pre-push hook

### Requirement: Plugin is installable via `path:` install after cloning the rembric repository

The plugin SHALL be installable by cloning the rembric repository and running `openclaw plugins install path:<clone-root>/plugin/.openclaw-plugin` (or the `--link` variant for symlink dev installs), with no intermediate build, npm publish, or marketplace registration step. The `git:` install kind is NOT supported as v1 install path because OpenClaw's git-install code expects `package.json` and `openclaw.plugin.json` at the cloned repository root (per `src/plugins/install.ts:1285`), and this plugin lives at `plugin/.openclaw-plugin/` inside the shared `plugin/` tree. A follow-up change MAY introduce a satellite repository or ClawHub publication to unlock single-command `git:` install; that work is out of scope here.

#### Scenario: Documented install command resolves to the OpenClaw plugin

- **WHEN** an OpenClaw user runs the install commands documented in `docs/agents.md::OpenClaw` — `git clone` followed by `openclaw plugins install path:<clone>/plugin/.openclaw-plugin`
- **THEN** OpenClaw SHALL locate `plugin/.openclaw-plugin/openclaw.plugin.json` and `package.json`, register the plugin under `id: "rembric"`, and stage it for activation
- **AND** the install SHALL NOT require the user to run `pnpm install`, `pnpm build`, or any other developer-side command first
- **AND** the install SHALL NOT require ClawHub publishing

#### Scenario: No local marketplace.json ships at the repo root

- **WHEN** the repository is at HEAD
- **THEN** `.openclaw-plugin/marketplace.json` SHALL NOT exist (unlike `.claude-plugin/marketplace.json` and `.codex-plugin/marketplace.json` which DO exist)
- **AND** the plugin's discoverability SHALL come from the documented `path:` install command and the `plugin/.openclaw-plugin/` manifest, not from a marketplace registry file in this repo

### Requirement: Plugin release SHALL bump all four client manifest versions in lock-step

When any file under `plugin/` is modified, the release commit SHALL bump the `version` field in ALL FOUR client manifests in the same commit: `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`, AND `plugin/.openclaw-plugin/openclaw.plugin.json`. This SHALL replace the prior triple-bump rule in `CLAUDE.md::Releasing a new plugin version`.

#### Scenario: Quadruple bump is enforced

- **WHEN** a change touches any file under `plugin/`
- **THEN** the same commit SHALL bump the `version` field in all four manifests by SemVer rules (patch for fixes, minor for behaviour, major for breaking)
- **AND** `plugin/CHANGELOG.md` SHALL gain a matching `[X.Y.Z] — <date>` heading

#### Scenario: CLAUDE.md reflects the four-client rule

- **WHEN** `CLAUDE.md` is read
- **THEN** the "Releasing a new plugin version" section SHALL list four manifests (Claude, Codex, Hermes, OpenClaw) and use the word "quadruple" (or equivalent) instead of "triple"
- **AND** the rationale paragraph SHALL be updated to mention OpenClaw's reliance on the version field for the same caching/update semantics

### Requirement: Documentation SHALL warn users about memory-slot collisions

`docs/agents.md` and the plugin's own README SHALL include a section that explicitly addresses the OpenClaw memory-slot ownership model and the collision case with `memory-lancedb` / `agentmemory`.

#### Scenario: Install docs include the slot config snippet

- **WHEN** a user reads `docs/agents.md::OpenClaw`
- **THEN** the section SHALL include the literal `~/.openclaw/openclaw.json` snippet that designates Rembric as the active memory provider (`plugins.slots.memory: "rembric"`) and configures the plugin entry (`enabled: true`, `config.server_url`, `config.api_token`, `config.autoRecall: true`, `config.autoCapture: false`)
- **AND** the snippet SHALL be tagged as JSONC (comments allowed) so inline guidance about each field is readable

#### Scenario: Collision warning is unambiguous

- **WHEN** the same section is read
- **THEN** a clearly-marked warning SHALL explain that only one `plugins.slots.memory` can be active at a time, that installing Rembric while `memory-lancedb` or `agentmemory` is in the slot will leave Rembric's auto-recall inactive, and that the user MUST update the slot config to switch
- **AND** the warning SHALL mention the runtime log line emitted by the plugin when slot ownership mismatches (per the memory-capability scenario above) so users can diagnose without re-reading docs

#### Scenario: Auto-recall token-budget caveat is documented

- **WHEN** the same section is read
- **THEN** the docs SHALL note that `autoRecall: true` injects context into every prompt, controlled by `tokenBudget`, and that users coming from `memory-lancedb` / `agentmemory` may want to tune `tokenBudget` to match their prior plugin's budget
