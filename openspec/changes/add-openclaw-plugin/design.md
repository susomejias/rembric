## Context

OpenClaw is a fourth agent runtime joining the three Rembric already supports (Claude Code, Codex CLI, Hermes Agent). Unlike Claude Code and Codex — which run our plugin as an MCP server + shell hooks — OpenClaw has a fundamentally different plugin model:

- **Bundle detection**: OpenClaw can read `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json` and execute their `.mcp.json`, skills, and commands. But it **does NOT execute Claude/Codex `hooks.json` files** — they are detected but ignored. Dropping `plugin/` under OpenClaw as a bundle therefore loses the entire session-lifecycle pipeline (session_start, summary writing, prompt-search-on-recall, compaction handling).
- **Native plugin model**: OpenClaw provides a formal memory-provider role via `kind: "memory"` plugins. A native plugin registers tools, hooks, an interactive handler, and a memory-capability programmatically through `OpenClawPluginApi` (`api.registerTool`, `api.on`, `api.registerInteractiveHandler`, `api.registerMemoryCapability`, `api.registerMemoryPromptSection`). The plugin runs **in-process** inside OpenClaw's Node gateway — no MCP subprocess.
- **Memory slot**: OpenClaw has a single active memory plugin per instance, designated in `~/.openclaw/openclaw.json` via `plugins.slots.memory`. The active plugin's prompt-section builder is auto-wired into prompt assembly. Existing memory plugins in the OpenClaw ecosystem (`memory-lancedb` shipped with OpenClaw, `agentmemory` third-party) follow this pattern.

The architectural axis is "shell-hook clients (MCP + bash) vs in-process clients (native provider in the host runtime)". Hermes already sits on the in-process side, using a Python `MemoryProvider`. OpenClaw is the same shape with a different runtime: in-process TypeScript inside OpenClaw's Node gateway.

The HTTP API at `/api/<slug>/sessions(*)` (capability `http-api`) is the shared contract. Hermes' Python provider, Claude Code's bash hooks, Codex CLI's bash hooks, and now OpenClaw's TS handlers all POST the same payloads to the same endpoints. The contract is the API, not the file.

Reference plugins consulted during explore:

- `/tmp/openclaw/extensions/memory-lancedb/` — OpenClaw's own in-tree memory plugin. Demonstrates `kind: "memory"`, `configSchema` + `uiHints.sensitive`, programmatic registration via `definePluginEntry`, `tsdown` build setup.
- `/tmp/agentmemory/integrations/openclaw/` — third-party memory plugin. Demonstrates the same multi-marketplace pattern Rembric uses (shared Claude/Codex tree + Hermes provider + OpenClaw native).
- `/tmp/openclaw/src/auto-reply/reply/plugins-commands.ts:46` — confirms `openclaw plugins install` accepts `path | archive | npm-spec | git:repo | clawhub:pkg` as source kinds.

## Goals / Non-Goals

**Goals:**

- Feature parity with Claude Code under OpenClaw: automatic session_start, summary on end, recall-on-trigger, compaction handling, full memory tool surface.
- Use OpenClaw's idiomatic primitives (`registerMemoryCapability`, `registerMemoryPromptSection`, `registerInteractiveHandler`) rather than retrofitting shell-hook semantics.
- Reuse the existing HTTP contract — zero new endpoints, zero new server-side code.
- Keep the shared `plugin/` tree consistent with the existing per-client divergence rule from `CLAUDE.md`: divergence ONLY when the platform forces it.

**Non-Goals:**

- ClawHub publishing in v1. Git URL install is enough; ClawHub is a follow-up change.
- Auto-capture default ON. The default is OFF because auto-capture conflicts with Rembric's `topic_key` + judgment-driven write model and needs a dedicated design pass.
- Local `.openclaw-plugin/marketplace.json` at repo root. OpenClaw has no documented local-marketplace concept; install specs are `path | archive | npm-spec | git:repo | clawhub:pkg`.
- Reusing `plugin/scripts/*.sh` from inside the OpenClaw handlers (no `child_process.spawn` shell-out). In-process TS reimplements the POST logic natively — same principle as the Hermes Python provider.
- Migration tooling from memory-lancedb / agentmemory to Rembric. Manual config edit per docs is sufficient for the user base size.
- Changes to load-bearing Rembric invariants (append-only memory, scope-at-service, convergent topics via `topic_key`, fresh-context judgment). The plugin only consumes the existing HTTP API — no new invariants, no relaxations.

## Decisions

### Decision 1: Native OpenClaw plugin, not a Codex/Claude bundle piggyback

**Chosen**: ship a native plugin at `plugin/.openclaw-plugin/` with its own `openclaw.plugin.json` manifest and TS entry point.

**Alternatives considered**:

- **(A) Piggyback on `.codex-plugin/`** — let OpenClaw detect it as a Codex bundle. **Rejected**: OpenClaw does not execute Codex hook JSON, so session lifecycle would be entirely absent. MCP-only behaviour was not enough for the use case the user named (`/dashboard/sessions` would stay empty, no automatic recall, no compaction handling).
- **(B) File-based hook layout (`hooks/HOOK.md + handler.ts`)** — present in OpenClaw bundles. **Rejected**: this layout is bundle-specific (Codex-compatible only per `/tmp/openclaw/docs/plugins/bundles.md`); native OpenClaw plugins register hooks programmatically via `api.on(...)`. The file-based path is for operator-installed hooks, not plugin lifecycle.
- **(C) Native plugin (chosen)** — first-class OpenClaw integration with full feature parity.

**Rationale**: only the native path gives us session_start/end, compaction hooks, and access to the formal memory slot. The cost is owning a TypeScript build target inside `plugin/` — acceptable, and already idiomatic per memory-lancedb's setup.

### Decision 2: Claim the memory slot via `kind: "memory"` + `registerMemoryCapability`

**Chosen**: the manifest declares `kind: "memory"` and the entry registers a capability via `api.registerMemoryCapability(...)`. The plugin will appear in OpenClaw's `plugins.slots.memory` candidate list and the user must designate Rembric explicitly.

**Alternatives considered**:

- **(A) Don't claim the slot — register tools and hooks only**. **Rejected**: the prompt-section auto-recall integration (`api.registerMemoryPromptSection(...)`) is one of the SDK's "exclusive slots" — only the active memory plugin can register it. Without slot ownership we lose auto-recall, which is the whole point of integrating with OpenClaw's prompt assembly pipeline.
- **(B) Claim the slot (chosen)**. Costs collision with users who already designated a different memory plugin (memory-lancedb, agentmemory). Mitigated by clear documentation and a config snippet (see Risks).

**Rationale**: auto-recall is a load-bearing user-facing feature. Without slot ownership it becomes manual ("call `memory_recall` tool every turn"), which defeats the purpose of an integration plugin.

### Decision 3: Plain ESM `.mjs` plugin, no TypeScript, no build step

**Chosen**: source lives directly in `plugin/.openclaw-plugin/*.mjs`. The manifest's `openclaw.extensions: ["./plugin.mjs"]` points at the entry file. No `tsdown`, no `tsconfig.json` under the sub-tree, no `dist/` directory, no CI drift checks, no pre-commit rebuild hooks.

**Pivot history (documented per project owner request)**: this decision was originally TS + `tsdown` build → committed `dist/index.mjs`. The pivot to plain `.mjs` happened during the `/opsx:apply` discovery phase when the implementation found that the OpenClaw plugin SDK is **not installable outside the OpenClaw monorepo**:

- `/tmp/openclaw/extensions/memory-lancedb/package.json` declares `"@openclaw/plugin-sdk": "workspace:*"` — `workspace:*` is a pnpm/yarn workspace protocol that only resolves inside the OpenClaw monorepo. The package is not published to npm.
- The third-party reference `/tmp/agentmemory/integrations/openclaw/` ships **plain hand-written `plugin.mjs`** with no TS, no build, no SDK dependency. Their `package.json::openclaw.extensions: ["./plugin.mjs"]` points at the ESM file directly.
- TypeScript without the SDK types would be untyped JavaScript with `any` annotations everywhere — every `api.registerTool(…)`, `api.on(…)`, `api.registerMemoryCapability(…)` call resolves to `any`. The type-safety benefit collapses; only the build overhead remains.

**Alternatives considered**:

- **(A) Plain `.mjs` plugin (chosen)** — hand-written ESM, ~600-1000 lines across 5-8 files. Matches `agentmemory`'s precedent exactly. Same authoring style as `plugin/bin/rembric-bridge.mjs` (121 lines, ESM, edit-in-place). Linted by ESLint; tested by Vitest (which natively runs `.mjs`). No build step means no committed build artifacts, no drift between source and runtime.
- **(B) TS source + committed `dist/index.mjs`** — originally chosen, now rejected. Costs: an extra `tsconfig.json` and `tsdown.config.ts` per sub-tree, committed `dist/` directory (single-digit KB per release but still a maintenance surface), pre-commit hook to keep `dist/` in sync, CI `git diff --exit-code dist/` to catch drift. Benefit (type safety) does not materialise because the SDK is not installable. Net: pure overhead.
- **(C) TS source executed via Node's `--experimental-strip-types` flag** — `openclaw.extensions: ["./plugin.mjs"]` would become `["./plugin.ts"]` and rely on the OpenClaw host invoking Node with `--experimental-strip-types`. Rejected: unverified that OpenClaw's plugin loader runs under this flag for installed third-party plugins (we know it uses the flag for some internal scripts, but the plugin-VM entry path is not documented). If the assumption is wrong, the plugin silently fails to load. The risk-to-reward is unfavourable when the SDK types aren't available anyway.
- **(D) Pure TS like memory-lancedb (workspace package)** — not viable. memory-lancedb is bundled inside OpenClaw's monorepo and gets compiled by OpenClaw's central `tsdown` build. We are an external plugin distributed via git, with no compile step at install time.

**Rationale for keeping this decision documented even after the pivot**: future maintainers reading this archive may ask "why didn't we use TypeScript?" — particularly because Rembric's main codebase IS strict TypeScript. The answer is environment-specific: the OpenClaw external-plugin ecosystem does not currently expose the plugin SDK as an installable package. If/when `@openclaw/plugin-sdk` ships to npm, revisit this decision in a follow-up change. Until then, plain `.mjs` is the idiomatic third-party path.

**Lint coverage**: the new `.mjs` files SHALL be covered by the repo's ESLint config (which already targets `*.mjs` per `package.json::lint-staged`). No new ESLint rules required.

### Decision 4: JS reimplementation of POSTs, not shell-out to `plugin/scripts/*.sh`

**Chosen**: the OpenClaw plugin's HTTP client (`src/http-client.ts`) reimplements the POSTs natively in TS using `fetch`. No `child_process.spawn` calls to `_api.sh`.

**Alternatives considered**:

- **(A) JS reimplementation (chosen)** — duplicates ~80 lines of POST/slug-read logic between `_api.sh` (bash) and `http-client.ts` (TS).
- **(B) Shell out via `child_process.spawn('bash', ['scripts/session-start.sh'])`** — maximum reuse of existing scripts. **Rejected**: OpenClaw doesn't document path resolution from in-process handlers to the plugin's `${plugin_root}/scripts/` directory; `import.meta.url` / `__dirname` is fragile for shipped builds; Windows users can't run bash; in-process subprocess management adds complexity for no real win.
- **(C) Extract shared logic to a `lib/api.mjs` that both bash scripts and TS handlers can `node`-invoke** — single source of truth in JS. **Rejected**: forces a rewrite of Claude/Codex bash scripts to call JS, which touches three working clients to support a fourth. Not worth the blast radius.

**Rationale**: the principle from `CLAUDE.md` ("shared logic lives in the HTTP API contract; per-client adapters MAY be written in any language") explicitly anticipates this. Hermes already reimplements the same POST contract in Python; OpenClaw doing the same in TS is the natural extension.

### Decision 5: `registerInteractiveHandler` for the recall matcher, not filtering inside `before_prompt_build`

**Chosen**: the `remember|recall|acordate|qué hicimos|what did we do` matcher is wired via `api.registerInteractiveHandler({ pattern: /.../, handler })`.

**Alternatives considered**:

- **(A) Filter inside `api.on('before_prompt_build', ...)`** — every prompt fires the hook and the handler checks the prompt against the regex internally. **Rejected**: wastes hook invocations on every turn even when no recall trigger is present; the SDK has a dedicated interactive-handler API specifically for this pattern (matched user input).
- **(B) `api.registerInteractiveHandler(...)` (chosen)** — pattern is registered with the host; the handler only fires when the matcher hits.

**Rationale**: idiomatic to OpenClaw, lower runtime overhead, and intent is explicit at the registration site. Matches what `memory-lancedb` does for its memory triggers.

### Decision 6: `autoRecall: true` default, `autoCapture: false` default

**Chosen**: the config schema exposes both booleans. `autoRecall` defaults true (auto-inject memories into every prompt via the registered prompt-section). `autoCapture` defaults false (no automatic write on agent_end).

**Alternatives considered**:

- **(A) Both ON** — mirrors memory-lancedb's defaults. **Rejected**: auto-capture conflicts with Rembric's `topic_key` + judgment-driven write model. memory-lancedb's auto-capture is uncritical (vector-search retrieval is robust to noise); Rembric's append-only `(scope, project_id, topic_key)` graph is not. Letting auto-capture write without an explicit `topic_key` would either generate orphans (no topic clustering) or fabricate topic_keys client-side (drift between client and server).
- **(B) Both OFF** — most conservative. **Rejected**: defeats the value of integrating with OpenClaw's prompt-section slot. If auto-recall is off by default, the plugin is functionally equivalent to "register some tools" — no different from a generic MCP integration.
- **(C) `autoRecall` ON, `autoCapture` OFF (chosen)** — recall is cheap and useful; capture is risky and needs separate design. User can flip `autoCapture` on in their config if they accept the trade-offs.

**Rationale**: the asymmetry between reads (cheap, useful, idempotent) and writes (invariant-bound, requires `topic_key` discipline) justifies the asymmetric default.

### Decision 7: Distribution via `openclaw plugins install git:<repo-url>`, no local marketplace file

**Chosen**: documented install path is `openclaw plugins install git:https://github.com/susomejias/rembric.git` (exact subdir syntax confirmed at implementation — likely `#subdir=plugin/.openclaw-plugin` or `path:` form).

**Alternatives considered**:

- **(A) Add `.openclaw-plugin/marketplace.json` at the repo root** — mirrors what Claude Code and Codex do. **Rejected**: OpenClaw's install CLI accepts `path | archive | npm-spec | git:repo | clawhub:pkg` (per `auto-reply/reply/plugins-commands.ts:46`); none of those are "local marketplace.json with git-subdir source". The Codex/Claude pattern doesn't translate to OpenClaw's CLI.
- **(B) Publish to ClawHub as `@susomejias/rembric`** — official distribution channel. **Deferred to follow-up change**: ClawHub publishing has its own onboarding flow (per `docs.openclaw.ai/clawhub/publishing.md`); shipping v1 via git install is faster and OpenClaw users routinely install plugins this way.
- **(C) Git install (chosen)** — direct, no third-party registry, matches how memory-lancedb's third-party clones are installed.

**Rationale**: ship the simplest distribution that works. ClawHub becomes a follow-up once we want broader discoverability.

### Decision 8: Quadruple version bump in lock-step

**Chosen**: every plugin-tree change bumps all four client manifests in the same commit: `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`, `plugin/.openclaw-plugin/openclaw.plugin.json`.

**Alternatives considered**:

- **(A) Independent versions per client** — bump only the manifests whose client is affected. **Rejected**: too easy to drift. The shared scripts and `http-client` logic affect all clients, even when the change "feels" client-specific. Tracking which clients a change affects is a recurring source of mistakes; quadruple-bump removes the cognitive overhead.
- **(B) Quadruple bump (chosen)** — every release ships uniform versions across all four manifests.

**Rationale**: the existing triple-bump rule worked; extending it to four is mechanical. `plugin/CHANGELOG.md` remains the single source of release notes.

## Risks / Trade-offs

[Risk] **Memory-slot collision with users who already configured `memory-lancedb` or `agentmemory`** → Mitigation: the install docs and the plugin README explicitly call out `plugins.slots.memory` ownership; provide the exact snippet to switch the slot to `rembric`. Add a startup log line in the plugin entry that warns when `api.config.plugins.slots.memory !== 'rembric'` (best-effort — the SDK exposes `api.config`).

[Risk] **OpenClaw SDK is sparsely documented; `registerMemoryCapability` interface details are inferred from `memory-lancedb` source** → Mitigation: implementation reads `/tmp/openclaw/src/plugins/types.ts` directly before wiring. If the interface differs from what we expected, the change adapts in implementation without re-proposing — the spec requirements are behavior-level, not signature-level.

[Risk] **`openclaw plugins install git:URL` subpath syntax for `plugin/.openclaw-plugin/`** → Mitigation: if `#subdir=` is not supported, fall back to documented `path:` install (clone first, then `openclaw plugins install path:./rembric/plugin/.openclaw-plugin`). The choice is implementation-level; the spec requirement is "installable from this repo without a separate publishing step".

[Risk] **Auto-recall token budget collisions with users coming from memory-lancedb** → Mitigation: `tokenBudget` is exposed in `configSchema` with a documented default (TBD at implementation, likely 1500-2000 tokens to match memory-lancedb's baseline); docs explain the trade-off (more budget = more context, more LLM cost).

[Risk] **No TypeScript type safety on the OpenClaw plugin SDK surface** → Mitigation: the plugin entry includes JSDoc-style type hints inline (lightweight) plus runtime assertions via small helper functions; integration tests against a fake `api` object exercise the registration paths. Hand-rolled `.mjs` is the explicit trade per Decision 3 — the SDK is not installable, so untyped JS is the only viable path until upstream publishes types.

[Trade-off] **Heavier per-release process (quadruple bump)** → Accepted because the cost is one extra version-bump line per release, paid by maintainers; benefit is consistent versioning across clients which is what `/plugin update` and `~/.openclaw/plugins/` caches depend on.

[Trade-off] **Three languages now in `plugin/` (bash for Claude/Codex, Python for Hermes, plain ESM JavaScript for OpenClaw)** → Accepted because each client's host platform dictates its native runtime; trying to unify forces shell-out from in-process clients, which we explicitly rejected in Decision 4. The JavaScript files use the same authoring style as `plugin/bin/rembric-bridge.mjs` (hand-written ESM, edit-in-place) so the maintenance pattern is consistent.

## Migration Plan

This is a net-new client — no users have an existing Rembric+OpenClaw setup to migrate. The migration is purely operational on the maintainer side:

1. Land the change, bump all four manifest versions (first quadruple bump).
2. Update `plugin/CHANGELOG.md` with an entry describing the new OpenClaw client.
3. Push a tag. release-please opens the PR.
4. After merge, `docs/agents.md` becomes the canonical OpenClaw install instruction for end users.

Rollback: if a critical issue surfaces post-release, revert the merge commit and re-tag. The plugin tree returns to its pre-OpenClaw state. Claude/Codex/Hermes users are unaffected (their sub-trees are untouched by this change).

## Open Questions

These are implementation-time confirmations, not spec ambiguities — they don't block proposal acceptance:

1. **Exact `registerMemoryCapability` interface shape**: confirmed at implementation by reading `/tmp/openclaw/src/plugins/types.ts` and `memory-lancedb/index.ts` source. The spec captures behaviour (claim the slot, expose recall/store/list adapters); the TS interface is enforced by the SDK.
2. **Exact `openclaw plugins install` subpath syntax** for `plugin/.openclaw-plugin/`: tested empirically at implementation. Spec captures "installable from this repo".
3. **Whether `api.pluginConfig` exposes secrets directly or via a getter**: confirmed at implementation. The plugin uses whatever the SDK provides; spec captures "credentials sourced from configSchema, never from process env".
4. **`tokenBudget` default value**: chosen at implementation, calibrated against memory-lancedb's default (around 1500-2000). Spec captures "configurable, with a documented default".
5. **Module split for the `.mjs` entry**: implementation chooses how to slice the entry into helper files (`plugin.mjs` + `http-client.mjs` + `tools.mjs` + ...) based on what reads cleanest. Spec captures behaviour, not file boundaries.
