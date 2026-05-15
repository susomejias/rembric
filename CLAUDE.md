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

## Running locally

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
pnpm run dev    # tsc --watch
pnpm start      # run the built server
```

MCP at `http://127.0.0.1:8787/mcp`, dashboard at `http://127.0.0.1:8787/dashboard`. Server binds to `127.0.0.1` only; remote exposure is the operator's responsibility (not shipped).
