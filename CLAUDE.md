# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This repo uses **pnpm** (pinned via `packageManager` in `package.json`). Enable via `corepack enable`.

| Task                | Command                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| Install             | `pnpm install`                                                              |
| Build               | `pnpm run build` (clean + `tsc -p tsconfig.build.json` + copy assets)       |
| Watch build         | `pnpm run dev`                                                              |
| Run built server    | `pnpm start` (requires `REMBRIC_ADMIN_TOKEN`)                               |
| Typecheck           | `pnpm run typecheck` (`tsc --noEmit`)                                       |
| Lint                | `pnpm run lint` / `pnpm run lint:fix`                                       |
| Format              | `pnpm run format` / `pnpm run format:check`                                 |
| Test (full)         | `pnpm test`                                                                 |
| Test (watch)        | `pnpm run test:watch`                                                       |
| Test (coverage)     | `pnpm run test:coverage` (gated: ≥90% stmts, ≥85% branches/functions/lines) |
| Single test file    | `pnpm vitest run path/to/file.test.ts`                                      |
| Single test by name | `pnpm vitest run -t "partial name"`                                         |
| DB schema gen       | `pnpm run db:generate` (drizzle-kit)                                        |
| DB migration check  | `pnpm run db:check`                                                         |

The CLI exposes subcommands once built: `rembric project create|list`, `rembric session list|delete`, `rembric token create|revoke`. See README "Operating the CLI".

Git hooks (run automatically; do not bypass with `--no-verify`):

- **pre-commit**: `lint-staged` (Prettier + ESLint on staged files) then `tsc --noEmit --incremental`.
- **commit-msg**: `commitlint` (Conventional Commits required — `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`).
- **pre-push**: full `pnpm test`.

## Architecture

Single Node process, single SQLite file. The README has the full diagram; this section calls out invariants and cross-file flows that you can't see from one file.

### Layered structure

```
src/
  server/    HTTP (Node http + Hono for /dashboard, raw IncomingMessage for /mcp)
             auth.ts → request-context.ts (AsyncLocalStorage) → session-router.ts
  mcp/       MCP tool handlers — thin wrappers over services, called via the
             SDK's StreamableHTTP transport. tools.ts owns memory.*; sessions-tools.ts
             owns memory.session_*, memory.context, memory.timeline, etc.;
             project-tools.ts owns project.*; relations-tools.ts owns judge/compare.
  dashboard/ SSR HTML + HTMX (Hono). One module per page.
  services/  Domain logic. MemoryService, RelationsService, ProjectsService,
             TokensService, AgentSessionsService, PromptsService, scope.ts.
             Scope is enforced at the SQL level here so handlers can't leak.
  db/        Drizzle schema + client + migrations. Append-only.
  consolidation/  Background workers — decay (deterministic) and
                  orphan-promotion (LLM judge over old pending judgments).
  llm/       OpenAI-compatible client (works against Ollama, LM Studio, vLLM, etc.).
  cli/       commander-based CLI subcommands.

plugin/      Shared plugin tree for BOTH Claude Code and Codex CLI marketplaces.
             plugin/.claude-plugin/plugin.json   Claude Code manifest
             plugin/.codex-plugin/plugin.json    Codex manifest
             plugin/mcp.json                     shared MCP server config
                                                 (bundled bridge via
                                                 ${CLAUDE_PLUGIN_ROOT})
             plugin/hooks/hooks.json             Claude Code hooks
             plugin/hooks/hooks.codex.json       Codex hooks (subset; cmd-only)
             plugin/scripts/                     shared hook scripts (both
                                                 clients honour ${CLAUDE_PLUGIN_ROOT})
             plugin/bin/rembric-bridge.mjs       bundled stdio↔HTTP bridge

.claude-plugin/marketplace.json   marketplace for `claude plugin install`
.codex-plugin/marketplace.json    marketplace for `codex plugin install`
                                  (git-subdir source against ./plugin)
```

### Load-bearing invariants (do NOT violate without an OpenSpec change)

- **Append-only memory.** Rows are never `DELETE`d; `content` is never `UPDATE`d. Lifecycle is `status` flips (`active` → `superseded` | `archived`) plus `replaces` links. Every consolidation op is journaled and reversible.
- **Scope is enforced in the service layer.** Every `MemoryService` query filters by `Scope` (`SCOPE_GLOBAL` or `projectScope(id)`). Cross-scope reads return `not_found`, not the row. Tools resolve scope once and thread it down; they never query DB directly.
- **Convergent topics via `topic_key`.** On `memory.save`, the previously-active row in the same `(scope, project_id, topic_key)` is auto-superseded atomically inside `saveWithTopicKey`.
- **Fresh-context judgment.** Candidate conflicts surface synchronously in `memory.save.candidates[]`. The agent that produced the conflict judges it via `memory.judge`. Nightly consolidator only does decay + orphan promotion of pending rows older than `JUDGMENT_ORPHAN_AFTER_MS`.

These invariants have dedicated tests; do not weaken them.

### Scope resolution (the trickiest cross-file flow)

When a request hits `/mcp` or `/mcp/<slug>`:

1. `server/http.ts` extracts the URL slug and calls `authenticate()` from `server/auth.ts`.
2. `authenticate()` returns a `RequestContext` carrying `project` (resolved from URL slug only) and `requestedSlug` (the literal slug, regardless of whether it resolved). This context is stashed in `AsyncLocalStorage` via `runWithContext`.
3. Tool handlers read the context via `getRequestContext()`. **`ctx.project` is the URL-derived project — it does NOT reflect `project.use({slug})` calls.**
4. `project.use` writes the chosen project into `SessionRouter` (in-memory, keyed by `(tokenId, mcpSessionId)`), NOT into the context.
5. Tools that need the effective project must consult BOTH sources. Precedence: `ctx.project` first, then `SessionRouter.get(...).projectId`. The helpers that do this:
   - `src/mcp/tools.ts` → `resolveEffectiveProject(deps)` for `memory.{save,search,get,confirm}`.
   - `src/mcp/sessions-tools.ts` → inline in `handleSessionStart`; `scopeFromContext(deps)` for `memory.{context,timeline,stats,save_prompt,capture_passive}`.
   - `src/mcp/project-tools.ts` → inline in `handleCurrent`.

**If you add a new MCP tool that needs project scope, follow this pattern — do not read `ctx.project` in isolation.** Path-scoped (`/mcp/<slug>`) connections still have `ctx.project` set, so the router fallback short-circuits cleanly. The fallback is gated on `ctx.requestedSlug === null` to preserve path-scoping semantics.

Path-scoping contract enforced in `tools.ts`:

- `/mcp/<slug>`: `scope='global'` save → `scope_locked`; `scope='project'` → saved to that project; cross-scope `get/confirm` → `not_found`.
- `/mcp`: `scope='project'` without an active project (URL or router) → `project_required`; `scope='global'` → saved as global.

### MCP server registration

`src/mcp/server.ts` (`createMcpServer`) registers every tool against the SDK. The factory closes over `requestedSlug` so `initialize.instructions` matches connection scope. `src/mcp/transport.ts` (`McpTransportManager`) is keyed by `mcp-session-id` header — each transport gets its own `McpServer` instance.

### Background workers

`src/consolidation/scheduler.ts` runs on `CONSOLIDATION_CRON` (default 03:00 daily). Triggered manually via `POST /admin/consolidation/run` (admin token required) or `rembric consolidation run-now`. The embedding worker runs every 30s + pre-consolidation. Both are wired in `src/server/bootstrap.ts`.

## OpenSpec workflow

Behavioral changes are spec-driven. Specs live in `openspec/specs/<area>/` (auth, consolidation, dashboard, mcp-api, memory, persistence, projects, sessions). Active proposals live in `openspec/changes/<name>/`; archived under `openspec/changes/archive/`.

Slash commands available in this repo (via `.claude/commands/`):

- `/opsx:propose`, `/opsx:explore`, `/opsx:apply`, `/opsx:archive`

Before changing a load-bearing invariant or adding a new MCP tool, open an OpenSpec change first.

## Code style highlights (from CONTRIBUTING.md)

- TypeScript strict; no `any` / `as unknown as T` without a justifying comment.
- No floating promises (ESLint enforces).
- `import type` for types, value imports otherwise; imports ordered builtin → external → internal → relative (auto-fixed).
- Co-located tests: `src/**/*.test.ts` next to the module.
- Invariant tests under `src/**/__tests__/invariants/` are sacred.
- **Default to no comments.** Write a comment only when its absence would cost a future reader real time: magic numbers/constants, non-obvious invariants, workarounds for library quirks, hidden side-effects, or public-API docstrings. Do NOT restate what the code does, reference the current task/PR, or leave TODO/FIXME without a tracked link. When in doubt, delete the comment and let names + structure speak.

## Plugin development discipline

Rembric ships one plugin tree (`plugin/`) consumed by multiple agent marketplaces (Claude Code, Codex CLI, future Cursor/Windsurf/etc.). To keep cross-client support sustainable:

- **Shared logic lives in shared paths.** `plugin/mcp.json`, `plugin/scripts/`, `plugin/skills/`, and `plugin/bin/` are consumed by every per-client manifest via `${CLAUDE_PLUGIN_ROOT}`. Add new scripts there, not under any client's manifest directory.
- **Per-client divergence ONLY when the platform forces it.** Different hooks files (`hooks/hooks.json` vs `hooks/hooks.codex.json`) are acceptable because the manifest format and supported event set differ. The scripts they invoke are SHARED — `session-start.sh`, `pre-compact.sh`, `session-stop.sh`, and the helper `_api.sh` work identically under Claude Code and Codex. Per-client script variants (`*-codex.sh`, `*-claude.sh`) are forbidden unless the script itself genuinely needs platform-specific logic.
- **Per-client manifests stay thin.** Each `.<client>-plugin/plugin.json` declares only what differs (paths to its hooks file, client-specific UI metadata). Anything that would also be true for another client gets factored into `plugin/`.
- **Quick sanity check.** `git ls-files plugin/` should show ONE copy of each shared resource. Two paths with near-identical content = sync bug to fix.

The bundled `plugin/bin/rembric-bridge.mjs` is the canonical bridge source. Both Claude Code and Codex spawn it via `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` from `plugin/mcp.json`. Edit in place; commit the file directly.

### Releasing a new plugin version — MUST bump `version` in both manifests

Both `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` declare a `version` field. Claude Code uses it as the cache key for `/plugin update` (official docs: `code.claude.com/docs/en/plugins-reference#version-management`) and Codex stores plugins under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. If you ship changes WITHOUT bumping the version, both clients will keep serving the cached old code and `/plugin update` will report "already at the latest version" — users have to manually uninstall + reinstall to recover.

**Rule**: any time you change something in `plugin/` that users need to see (scripts, hooks, mcp.json, bin/, manifests themselves), bump BOTH manifest versions in the same commit. Use SemVer:

- **patch** (`0.2.0` → `0.2.1`): bug fixes in hook scripts, helper functions, doc tweaks visible at runtime.
- **minor** (`0.2.0` → `0.3.0`): new behaviour (new hook, new endpoint touched, additional manifest field).
- **major** (`0.2.0` → `1.0.0`): breaking changes (renamed userConfig field, removed hook event, incompatible script CLI).

Mirror the same version in `plugin/CHANGELOG.md` (the `[X.Y.Z] — unreleased` heading). When the change merges to `main`, downstream users get the new version via the official update flow documented in `plugin/README.md` ("Updating to a new version") and `docs/agents.md` ("Updating the plugin"). Without the bump, those instructions silently no-op.

If you genuinely want every commit to auto-invalidate the cache (during heavy iteration), omit the `version` field entirely — Claude Code falls back to the git commit SHA per its docs. Re-add `version` before merging so end users have stable release semantics.

### Session lifecycle: HTTP, not MCP

Session creation/summary/end is driven by the plugin's `command` hooks POSTing to Rembric's `/api/<slug>/sessions(*)` HTTP endpoints (see `src/server/api-router.ts` and the `http-api` capability spec). The MCP tools `memory.session_start`, `memory.session_end`, `memory.session_summary` remain available for clients that don't run the plugin, but the canonical path is HTTP. This is why:

- `plugin/scripts/_api.sh` is the shared helper sourced by every script that talks to the API. Exposes `rembric_post`, `rembric_read_project_slug`, `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, and `rembric_json_escape`. Single canonical file — both clients pick up edits.
- **Hook env vars: per-client divergence forced by the platform.** Claude Code hooks run as sibling subprocesses of the MCP bridge and do NOT inherit `mcp.json:env`. The two clients differ in what they support:
  - **Claude Code** substitutes `${user_config.*}` in hook `command` strings (documented at `code.claude.com/docs/en/hooks`). `plugin/hooks/hooks.json` inline-prefixes each lifecycle hook with `REMBRIC_SERVER_URL='${user_config.server_url}' REMBRIC_API_TOKEN='${user_config.api_token}'`, so the install wizard's keychain values flow to the hooks automatically — users don't have to export anything in their shell.
  - **Codex** does NOT substitute `${user_config.*}` (verified against `developers.openai.com/codex/plugins/build`) and has no `userConfig` schema. `plugin/hooks/hooks.codex.json` therefore stays unprefixed — Codex users export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex`, the same way they already do for the bridge (per `docs/agents.md` Codex section).
  - The shared scripts (`_api.sh`, `session-start.sh`, `pre-compact.sh`, `session-stop.sh`) stay client-agnostic: they read the envs from process env regardless of how they got there. When envs are missing entirely, `_api.sh` writes a `[rembric] missing REMBRIC_*` diagnostic to stderr and exits 0.
- `memory.save` automatically attaches `session_id` to the most-recently-active session for `(token, project)` via `resolveActiveSessionId` in `src/mcp/tools.ts`. Agents never need to thread a session id manually.
- Session ids stay globally unique (`sessions.id TEXT PRIMARY KEY` unchanged from migration `0003`). Cross-token collisions are theoretical (UUID/ULID space) and are rejected at the service layer with `id_collision`.

## Running locally

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
pnpm run dev    # tsc --watch
pnpm start      # run the built server
```

MCP at `http://127.0.0.1:8787/mcp`, dashboard at `http://127.0.0.1:8787/dashboard`. Server binds to `127.0.0.1` only; remote exposure is the operator's responsibility (not shipped).
