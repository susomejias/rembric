## 1. Scaffold the OpenClaw plugin sub-tree

- [x] 1.1 Create `plugin/.openclaw-plugin/` and verify it sits sibling to the existing `.claude-plugin/`, `.codex-plugin/`, `.hermes-plugin/` directories.
- [x] 1.2 Add `plugin/.openclaw-plugin/package.json` with `name: "@rembric/openclaw-plugin"`, `private: true`, `type: "module"`, `version` matching the other three client manifests at the time of authoring, AND the OpenClaw-specific block `"openclaw": { "extensions": ["./plugin.mjs"] }`. NO `scripts.build`. NO `dependencies` or `devDependencies` block — the OpenClaw plugin SDK (`@openclaw/plugin-sdk`) is a `workspace:*` package not installable outside the OpenClaw monorepo; the runtime API is injected at plugin load time.
- [x] 1.3 Confirm there is NO `tsconfig.json`, NO `tsdown.config.*`, NO `dist/` directory under `plugin/.openclaw-plugin/`. The plugin is plain ESM JavaScript, hand-authored, edit-in-place.
- [x] 1.4 Confirm the repo-root ESLint config already targets `*.mjs` (`package.json::lint-staged` does — line ~66). Add `plugin/.openclaw-plugin/` to the ESLint `ignores` only if a file in the sub-tree needs a known exception; default is full coverage.
- [x] 1.5 Confirm root `pnpm test` (Vitest) discovers `.mjs` test files under `plugin/.openclaw-plugin/`. Vitest default glob includes `**/*.test.{js,mjs,cjs,ts,...}` — verify by adding a placeholder `plugin/.openclaw-plugin/_smoke.test.mjs` with one passing assertion, running `pnpm vitest run`, and then deleting the placeholder.
- [x] 1.6 Verify `git status` shows only changes under `plugin/.openclaw-plugin/` after scaffolding — no root `package.json`/`tsconfig.json`/`pnpm-lock.yaml` drift.

## 2. Write the native manifest

- [x] 2.1 Create `plugin/.openclaw-plugin/openclaw.plugin.json` with `id: "rembric"`, `kind: "memory"`, `name: "Rembric"`, a `description`, a `version` matching the package.json AND the other three client manifests at the time of authoring, AND `activation.onStartup: true`.
- [x] 2.2 Add `contracts.tools` listing all memory tools mirroring the MCP surface: `memory_save`, `memory_search`, `memory_get`, `memory_judge`, `memory_confirm`, `memory_compare`, `memory_context`, `memory_timeline`, `memory_stats`, `memory_session_start`, `memory_session_end`, `memory_session_summary`, `memory_save_prompt`, `memory_capture_passive`, `project_current`, `project_list`, `project_use`.
- [x] 2.3 Add `configSchema` with `type: "object"`, `additionalProperties: false`, and properties for `server_url` (string, required), `api_token` (string, required), `autoRecall` (boolean, default true), `autoCapture` (boolean, default false), `tokenBudget` (number, default 1800).
- [x] 2.4 Add `configContracts.secretInputs.paths` covering `api_token`.
- [x] 2.5 Add `uiHints.api_token` with `sensitive: true` and placeholder `"rbr_..."`; `uiHints.server_url` with placeholder `"https://memory.example.com"`; `uiHints.autoRecall` and `uiHints.autoCapture` with `help` strings explaining the trade-offs; `uiHints.tokenBudget` with `advanced: true` and help text.
- [x] 2.6 Verify NO `.mcp.json`, `hooks.json`, or other Claude/Codex-style bundle markers ship under `plugin/.openclaw-plugin/`.

## 3. Implement the HTTP client (`http-client.mjs`)

- [x] 3.1 Create `plugin/.openclaw-plugin/http-client.mjs` exporting a factory `createHttpClient({ serverUrl, apiToken, logger })` that returns an object with methods for each Rembric endpoint the plugin uses.
- [x] 3.2 Implement session-lifecycle methods matching the `http-api` capability shapes: `createSession({ id, cwd, agent, description })` → POST `/api/<slug>/sessions`; `summarizeSession({ slug, sessionId, summary, title, final })` → POST `/api/<slug>/sessions/<id>/summary`; `endSession({ slug, sessionId, summary, title, final })` → POST `/api/<slug>/sessions/<id>/end`.
- [x] 3.3 Implement memory-operation methods that speak to the MCP HTTP transport — `memorySave`, `memorySearch`, `memoryGet`, `memoryJudge`, `memoryConfirm`, `memoryCompare`, `memoryContext`, `memoryTimeline`, `memoryStats`, `memorySessionStart`, `memorySessionEnd`, `memorySessionSummary`, `memorySavePrompt`, `memoryCapturePassive`, `projectCurrent`, `projectList`, `projectUse`. Confirm at implementation whether the MCP transport requires a session-id header by reading `src/mcp/transport.ts`; if so, the client manages it transparently.
- [x] 3.4 Implement a `readProjectSlug(cwd)` helper that reads `<cwd>/.rembric` synchronously and parses `PROJECT_SLUG=<slug>`. Apply the same regex as `plugin/bin/rembric-bridge.mjs` (lowercase letters/digits/hyphens, 1-64 chars, cannot begin or end with a hyphen). Return `null` on any failure (missing file, parse error, regex mismatch, length).
- [x] 3.5 All client methods SHALL: build the `Authorization: Bearer <token>` header from the factory's `apiToken`; build the URL by joining the factory's `serverUrl` (trailing `/` stripped) with the endpoint path; use `fetch` with `signal: AbortSignal.timeout(5000)` (5s default timeout); catch every error (network, abort, JSON parse) and return a discriminated-union `{ ok: true, data } | { ok: false, code, message }`; never throw.
- [x] 3.6 Add `plugin/.openclaw-plugin/http-client.test.mjs` (Vitest) covering: successful POST returns `{ ok: true, data }`; 4xx response surfaces `{ ok: false, code, message }` from the server body; 5xx surfaces `{ ok: false, code: "server_error" }`; network failure surfaces `{ ok: false, code: "network_error" }`; timeout surfaces `{ ok: false, code: "timeout" }`; slug regex accepts valid slugs, rejects invalid.

## 4. Implement the entry (`plugin.mjs`)

- [x] 4.1 Create `plugin/.openclaw-plugin/plugin.mjs` exporting a `register(api)` function (or default export — confirmed at implementation against agentmemory's `/tmp/agentmemory/integrations/openclaw/plugin.mjs` signature).
- [x] 4.2 Inside `register`, read `api.pluginConfig` and parse it into a typed-ish shape using a small validator helper (no Typebox — plain runtime checks). Required: `server_url` (non-empty string), `api_token` (non-empty string). Optional: `autoRecall` (boolean, default `true`), `autoCapture` (boolean, default `false`), `tokenBudget` (number, default `1800`).
- [x] 4.3 Instantiate the HTTP client via `createHttpClient({ serverUrl, apiToken, logger: api.logger })`.
- [x] 4.4 Emit a structured warning via `api.logger` when `api.config?.plugins?.slots?.memory !== 'rembric'`, indicating that another plugin owns the memory slot and Rembric's auto-recall integration is inactive. Confirm `api.config` access path against agentmemory's reference at implementation.
- [x] 4.5 Wire all integration surfaces (sections 5-9 below) by calling per-surface helpers that take `(api, httpClient, config)`.

## 5. Wire tool registrations (`tools.mjs`)

- [x] 5.1 Create `plugin/.openclaw-plugin/tools.mjs` exporting `registerTools(api, httpClient)`. Inside, call `api.registerTool(...)` once per memory tool listed in `contracts.tools`. Each tool's name SHALL match the manifest exactly.
- [x] 5.2 Tool handlers SHALL forward arguments to the HTTP client method of the same name (e.g. `memory_save` → `httpClient.memorySave(args)`). The handler SHALL surface the response data as-is when `ok: true`; on `ok: false` it SHALL throw an Error whose message is the HTTP client's `message` field (OpenClaw's tool-error convention — confirm).
- [x] 5.3 Tool JSON schemas for each tool's arguments SHALL be authored inline in `tools.mjs` (each tool has a small literal schema). Schemas mirror the MCP tool schemas in `src/mcp/tools.ts` / `src/mcp/sessions-tools.ts` / `src/mcp/project-tools.ts` / `src/mcp/relations-tools.ts`.
- [x] 5.4 Add `plugin/.openclaw-plugin/tools.test.mjs` covering at minimum: `memory_save` success forwards args + returns server data; `memory_save` with conflict surfaces `candidates[]` from the server response; `memory_search` returns `memories[]`; `memory_judge` happy path; `project_use` happy path; tool error → handler throws with the server's error message.
- [x] 5.5 Add an invariant test that asserts the count of `contracts.tools` entries in the manifest equals the count of `api.registerTool` calls observed when `registerTools(fakeApi, fakeClient)` runs against a recording fake.

## 6. Wire session lifecycle hooks (`hooks.mjs`)

- [x] 6.1 Create `plugin/.openclaw-plugin/hooks.mjs` exporting `registerHooks(api, httpClient)`. Inside, call `api.on('session_start', ...)`, `api.on('session_end', ...)`, `api.on('before_compaction', ...)`, `api.on('after_compaction', ...)`. Confirm event names against agentmemory's reference at implementation (which uses `before_agent_start` and `agent_end`; the rembric set may differ — verify which fire for OpenClaw native plugins and pick the ones that map to our HTTP API contract).
- [x] 6.2 The `session_start` handler SHALL extract `sessionId` and `cwd` from the event object (field names confirmed at implementation), resolve the slug via `httpClient.readProjectSlug(cwd)`, and POST `{ id: sessionId, cwd, agent: 'openclaw' }` to `/api/<slug>/sessions` (when slug resolves) OR skip silently (when slug is null — global scope cannot upsert a session row by this design).
- [x] 6.3 The `session_end` handler SHALL extract the transcript/summary from the event (per OpenClaw's contract — confirm) and POST `{ summary, title?, final: true }` to `/api/<slug>/sessions/<id>/end`.
- [x] 6.4 The compaction handlers SHALL POST `{ summary: <compaction-output>, final: false }` to `/api/<slug>/sessions/<id>/summary`. Both before- and after-compaction are wired so the session's `summary` reflects whichever signal is richer at runtime.
- [x] 6.5 All hook handlers SHALL catch every error internally and log via `api.logger`. They SHALL NEVER throw out of the hook — host stability over POST success.
- [x] 6.6 Add `plugin/.openclaw-plugin/hooks.test.mjs` covering: each hook handler's payload shape; slug-null path is a silent skip; HTTP client failure is swallowed and logged.

## 7. Wire the interactive recall handler (`interactive.mjs`)

- [x] 7.1 Create `plugin/.openclaw-plugin/interactive.mjs` exporting `registerInteractive(api, httpClient)`. Inside, call `api.registerInteractiveHandler({ pattern, handler })`. The `pattern` SHALL match the regex `remember|recall|acordate|qué hicimos|what did we do` case-insensitively. Confirm the SDK's accepted `pattern` form (RegExp instance vs string source) at implementation.
- [x] 7.2 The handler SHALL call `httpClient.memorySearch({ query: userPrompt })` and inject the returned memories into the host's context-return value via the SDK's interactive-handler contract (confirmed at implementation — likely returns `{ prependContext: "..." }` or pushes to `event.messages`).
- [x] 7.3 Add `plugin/.openclaw-plugin/interactive.test.mjs` covering: matcher hits → search called with prompt text; matcher misses → handler not invoked; empty search result → benign no-op return (no thrown error).

## 8. Wire the memory capability and prompt section (`memory-capability.mjs`)

- [x] 8.1 Create `plugin/.openclaw-plugin/memory-capability.mjs` exporting `registerMemorySurface(api, httpClient, config)`.
- [x] 8.2 Inside, build a capability object whose recall/store/list adapters route through the HTTP client. Confirm the capability interface at implementation by reading `/tmp/openclaw/src/plugins/types.ts` plus `/tmp/agentmemory/integrations/openclaw/plugin.mjs` (search for `registerMemoryCapability`). Call `api.registerMemoryCapability(capability)`.
- [x] 8.3 When `config.autoRecall === true`, register a typed `before_prompt_build` hook that calls `memory.search` against the current prompt text and returns `{ prependContext }` sized to `config.tokenBudget`.
- [x] 8.4 When `config.autoRecall === false`, SKIP the `before_prompt_build` auto-recall hook entirely. Do not use `registerMemoryPromptSection` for async recall; OpenClaw's memory prompt section is synchronous `string[]` guidance only.
- [x] 8.5 The plugin SHALL NEVER call `httpClient.memorySave` from `agent_end` or any compaction hook when `config.autoCapture` is falsy. Add a test asserting this: a fake `agent_end` event with `autoCapture: false` → zero saves observed on the fake client.
- [x] 8.6 Create `plugin/.openclaw-plugin/tool-guards.mjs` registering `before_tool_call` to block OpenClaw `MEMORY.md` / `memory/*.md` writes and tell the agent to call `memory_save` instead. Add tests that the guard blocks file-backed memory paths but never blocks Rembric `memory_*` tools.

## 9. Wire the `/rembric` slash command (`commands.mjs`)

- [x] 9.1 Create `plugin/.openclaw-plugin/commands.mjs` exporting `registerCommands(api, httpClient, config)`. Inside, call `api.registerCommand({ name: 'rembric', ... })` whose default subcommand is `status`.
- [x] 9.2 `/rembric status` SHALL emit a structured status block: `server_url`, masked `api_token` (first 4 + last 4 chars, rest `*`), current session id (if known), slot ownership flag (`active` if Rembric owns the memory slot, `inactive` otherwise).
- [x] 9.3 Confirm at implementation whether further subcommands (`recall`, `remember`, `summary`) need wiring. Default for v1: `/rembric status` only.
- [x] 9.4 Add `plugin/.openclaw-plugin/commands.test.mjs` covering: `/rembric status` output format; token masking redacts the body of the token; slot-mismatch shows `inactive`.

## 10. Invariant tests

- [x] 10.1 Add `plugin/.openclaw-plugin/manifest-invariants.test.mjs` pinning `id`, `kind: "memory"`, every field in `contracts.tools`, the `configContracts.secretInputs` paths, and the `configSchema` required fields. Failures here mean the spec contract drifted silently.
- [x] 10.2 Add a "no bundle markers under OpenClaw sub-tree" invariant: assert `plugin/.openclaw-plugin/` does NOT contain `.mcp.json`, `hooks.json`, `hooks.codex.json`, or any `commands/` directory (those belong to the shared Claude/Codex tree).
- [x] 10.3 Add a "no build artifacts" invariant: assert `plugin/.openclaw-plugin/` does NOT contain `tsconfig.json`, `tsdown.config.*`, `dist/`, or any `.ts` files. The plugin is plain ESM, hand-authored, edit-in-place.
- [x] 10.4 Add a "version lockstep" invariant: assert `plugin/.openclaw-plugin/openclaw.plugin.json::version` matches `plugin/.openclaw-plugin/package.json::version` matches `plugin/.claude-plugin/plugin.json::version` matches `plugin/.codex-plugin/plugin.json::version` matches `plugin/.hermes-plugin/plugin.yaml::version`. This is the quadruple-bump enforcement.

## 11. Repo-level documentation updates

- [x] 11.1 Update `CLAUDE.md::Plugin development discipline` to list four clients (Claude/Codex/Hermes/OpenClaw), describe the new `.openclaw-plugin/` divergence axis (native plugin model, in-process plain ESM JS, memory-capability slot, no MCP under OpenClaw, no build step), and quote the install-spec source list (`path | archive | npm-spec | git:repo | clawhub:pkg` from `/tmp/openclaw/src/auto-reply/reply/plugins-commands.ts:46`) for traceability.
- [x] 11.2 Update `CLAUDE.md::Releasing a new plugin version` to replace "triple bump" → "quadruple bump"; add `plugin/.openclaw-plugin/openclaw.plugin.json` AND `plugin/.openclaw-plugin/package.json` to the lock-step manifest list; preserve the SemVer rationale.
- [x] 11.3 Update `CLAUDE.md::Session lifecycle: HTTP, not MCP` to mention that OpenClaw's lifecycle hooks also POST to the same HTTP API (Hermes Python + OpenClaw plain ESM JS + Claude/Codex bash all converge on `/api/<slug>/sessions(*)`).
- [x] 11.4 Add a new `## OpenClaw` section to `docs/agents.md` with: install command (`openclaw plugins install git:<repo-url>` — exact subdir/path syntax confirmed at impl), required `~/.openclaw/openclaw.json` slot + config snippet (JSONC), memory-slot collision warning, auto-recall token-budget note, "if you see X, the cause is Y" troubleshooting block (slot mismatch → no auto-recall; missing config → registration warning in logs).
- [x] 11.5 Add a `plugin/.openclaw-plugin/README.md` that mirrors the install/config snippet from `docs/agents.md` and links back to the main docs.
- [x] 11.6 Update `plugin/CHANGELOG.md` with a new entry describing the OpenClaw client addition (under the version being released). State explicitly that the plugin is plain ESM, no build step.

## 12. First quadruple version bump

- [x] 12.1 Bump `version` in all four manifests in the same commit: `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`, AND the new `plugin/.openclaw-plugin/openclaw.plugin.json` (plus `plugin/.openclaw-plugin/package.json` which mirrors the manifest version). Choose minor bump (new client = new behaviour).
- [x] 12.2 Confirm `plugin/CHANGELOG.md` heading matches the four manifests' new version.
- [x] 12.3 Confirm the version-lockstep invariant test (task 10.4) is green.

## 13. End-to-end manual verification (operator-only)

- [ ] 13.1 **Operator-only**: install the plugin locally. The v1 install path is `git clone <repo>` followed by `openclaw plugins install path:<clone>/plugin/.openclaw-plugin` (or `--link` for symlink dev install). The `git:URL@ref` form is NOT supported because OpenClaw expects the manifest at the cloned repo root — our plugin lives at `plugin/.openclaw-plugin/`. Confirm OpenClaw registers the plugin under `id: "rembric"`.
- [ ] 13.2 **Operator-only**: configure `~/.openclaw/openclaw.json` with `plugins.slots.memory: "rembric"` and the entry config block from `docs/agents.md`. Restart OpenClaw.
- [ ] 13.3 **Operator-only**: start an OpenClaw session in a project with `.rembric::PROJECT_SLUG=<slug>`. Verify `/dashboard/sessions` shows a new row with `agent='openclaw'`.
- [ ] 13.4 **Operator-only**: type a prompt matching `remember|recall` and verify the recall handler injects memories.
- [ ] 13.5 **Operator-only**: type a normal prompt and verify auto-recall injects context (with `autoRecall: true`).
- [ ] 13.6 **Operator-only**: end the OpenClaw session and verify the dashboard row shows `status='ended'` with a summary populated.
- [ ] 13.7 **Operator-only**: trigger a compaction and verify the session's `summary` updates mid-flight (per the `before_compaction`/`after_compaction` POSTs).
- [ ] 13.8 **Operator-only**: as an extra check, designate a non-Rembric plugin in `plugins.slots.memory`, restart, and verify the plugin emits the slot-mismatch warning via `api.logger`.

## 14. Cleanup and pre-PR checks

- [x] 14.1 Run `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`, `pnpm test` — all green.
- [x] 14.2 Run `openspec validate add-openclaw-plugin --strict` — green.
- [x] 14.3 Apply the `npm-security-best-practices` skill: confirm zero new entries in `pnpm-lock.yaml` (the OpenClaw sub-tree has NO dependencies); confirm no new `allowBuilds` entries needed; confirm lockfile-lint unchanged.
- [x] 14.4 `git grep` the diff for sensitive content per the rule in the tasks-instruction: no real tokens, no real server URLs, no maintainer paths. Use `<repo>`, `<token>`, `<server-host>`, `192.0.2.10` placeholders only.
- [x] 14.5 Squash-review the commit history on the feature branch; ensure conventional-commit messages and clean diffs.
- [x] 14.6 Open a PR titled `feat(plugin): add native OpenClaw plugin (memory-provider, kind=memory)` with the proposal as the description.
