## Why

OpenClaw is a fourth agent runtime users are asking Rembric to support. OpenClaw can detect Codex/Claude plugin bundles but only executes their MCP servers — it does NOT execute their hook JSON files, so dropping the existing `plugin/` tree under OpenClaw silently loses every session-lifecycle hook Rembric depends on (auto session_start, summary on end, prompt-search-on-recall, compaction handlers). The result is an empty `/dashboard/sessions` and no automatic memory recall under OpenClaw. To restore feature parity we need a native OpenClaw plugin that owns OpenClaw's formal memory-provider slot (`kind: "memory"`, `registerMemoryCapability`) and registers lifecycle hooks programmatically via OpenClaw's plugin SDK — the same architectural shape as the existing `hermes-agent-plugin` (in-process provider, not MCP subprocess).

## What Changes

- Add new shared sub-tree at `plugin/.openclaw-plugin/` containing a native OpenClaw plugin **hand-authored as plain ESM `.mjs`** (no TypeScript, no build step), claiming the OpenClaw memory slot and exposing every memory tool, lifecycle hook, and interactive matcher Rembric needs. Rationale documented in `design.md::Decision 3` — the OpenClaw plugin SDK (`@openclaw/plugin-sdk`) is a `workspace:*` package that does NOT ship to npm, so external TypeScript code cannot import its types. The closest third-party precedent (`agentmemory`'s OpenClaw integration) ships plain `.mjs` for the same reason.
- Register the plugin's tools via `api.registerTool(...)` (not MCP) — the same tool surface as our existing MCP server, but consumed in-process by OpenClaw.
- Register session lifecycle hooks via `api.on('session_start'|'session_end'|'before_compaction'|'after_compaction', ...)` that POST to Rembric's existing HTTP API (`/api/<slug>/sessions(*)`).
- Register a regex-matcher interactive handler via `api.registerInteractiveHandler(...)` for the `remember|recall|acordate|qué hicimos|what did we do` recall trigger — OpenClaw's idiomatic equivalent of the Claude/Codex `UserPromptSubmit` hook.
- Register an auto-recall builder via `api.registerMemoryPromptSection(...)` — default ON (`autoRecall: true`); auto-capture stays OFF by default (`autoCapture: false`) because it collides with Rembric's `topic_key` + judgment-driven write path and needs separate design.
- Distribute via `openclaw plugins install git:<repo-url>` (no local marketplace.json — OpenClaw's install CLI accepts `path | archive | npm-spec | git:repo | clawhub:pkg` per `src/auto-reply/reply/plugins-commands.ts:46`).
- **BREAKING** for the plugin release process: triple version bump becomes quadruple. `plugin/.openclaw-plugin/openclaw.plugin.json::version` joins the three existing manifests in the lock-step rule.
- Update `docs/agents.md` with a new OpenClaw section (install command, slot config snippet, memory-slot collision warning, auto-recall token-budget caveat).
- Update `CLAUDE.md`'s "Plugin development discipline" and "Releasing a new plugin version" sections to reflect the fourth client.

## Capabilities

### New Capabilities

- `openclaw-plugin`: native OpenClaw memory-provider plugin. Defines manifest contents at `plugin/.openclaw-plugin/openclaw.plugin.json`, the programmatic registration shape (tools, hooks, interactive handler, memory-capability, prompt-section), the HTTP contract reuse with the `http-api` capability, the build pipeline (TypeScript → `dist/index.mjs` via `tsdown`, both committed), distribution via `openclaw plugins install git:repo`, and the quadruple-bump release rule.

### Modified Capabilities

None. The `http-api` spec defines endpoint behaviour (request/response shapes, status codes, idempotency), not the set of consumers. OpenClaw becomes a fourth client of those endpoints without changing any requirement in the `http-api` spec — the consumer list is documentation, captured in `CLAUDE.md` and `docs/agents.md`.

## Impact

- **New files** under `plugin/.openclaw-plugin/`:
  - `openclaw.plugin.json` (native manifest with `kind: "memory"`, `configSchema`, `uiHints`, `configContracts.secretInputs`)
  - `package.json` (declares `type: "module"`, `openclaw.extensions: ["./plugin.mjs"]`, no SDK dependency — the host provides the API at runtime)
  - `plugin.mjs` (entry — `export default function register(api) { … }`)
  - `http-client.mjs` (HTTP client to Rembric server, replaces `_api.sh` logic in JS)
  - `tools.mjs` (registerTool wrappers — one export per memory tool)
  - `hooks.mjs` (session lifecycle handlers)
  - `interactive.mjs` (recall matcher handler)
  - `memory-capability.mjs` (capability adapter + prompt-section builder)
  - `README.md` (install + config snippet for plugin consumers)
- **Modified files**:
  - `CLAUDE.md` — plugin discipline section (fourth client) and release-bump rule (triple → quadruple).
  - `docs/agents.md` — new OpenClaw install section.
  - `plugin/CHANGELOG.md` — entry describing the new sub-tree.
  - `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml` — version bump in lock-step on first release of this change.
- **No changes to load-bearing invariants**:
  - Append-only memory: untouched. The plugin only consumes existing HTTP endpoints — no new physical-purge paths, no new write modes.
  - Scope-at-service: untouched. The plugin reads/writes through the same scoped HTTP API.
  - Convergent topics via `topic_key`: untouched. Auto-capture is OFF by default specifically to avoid bypassing the explicit `topic_key` workflow.
  - Fresh-context judgment: untouched. The plugin surfaces `candidates[]` from `memory.save` responses the same way the MCP server does.
- **Test surface**: new co-located `*.test.mjs` files under `plugin/.openclaw-plugin/` (Vitest's `.mjs` support) covering tool wiring, hook POST shapes, interactive matcher, and memory-capability adapter. Pin the manifest's `kind` and required fields in an invariant-style test.
- **Build pipeline**: **none**. The plugin ships hand-authored ESM that runs as-is. `pnpm typecheck` ignores the sub-tree (no `.ts` to check); ESLint coverage is added so syntax/format rules still apply.
- **Supply chain**: zero new dependencies in the root or the sub-tree. The OpenClaw plugin-SDK (`@openclaw/plugin-sdk`) is a `workspace:*` package not available on npm; the runtime API is injected by the OpenClaw host at plugin load time. Apply the `npm-security-best-practices` skill mostly as a no-op check — no new package additions to review.
- **Out of scope** (explicit non-goals deferred to follow-up changes): ClawHub publishing; auto-capture default ON; migration tooling from memory-lancedb / agentmemory to Rembric; local `.openclaw-plugin/marketplace.json` at repo root (OpenClaw has no documented local-marketplace concept).
