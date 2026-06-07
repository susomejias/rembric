# CLAUDE.md

Guidance for Claude Code working in this repo. Specs in `openspec/specs/` are the authoritative contract; this file is the must-know-fast index.

## Quick reference

| Need             | Command / path                                                         |
| ---------------- | ---------------------------------------------------------------------- |
| Install          | `pnpm install` (run `corepack enable` first)                           |
| Typecheck / lint | `pnpm run typecheck` · `pnpm run lint`                                 |
| Tests            | `pnpm test` (single file: `pnpm vitest run path/to/file.test.ts`)      |
| Dev stack        | `pnpm run dev:docker:up` (foreground, wipes+reseeds; `docs/docker.md`) |
| OpenSpec         | `/opsx:propose` · `/opsx:explore` · `/opsx:apply` · `/opsx:archive`    |

Conventional Commits required (commitlint). Pre-commit = lint-staged + `tsc --noEmit --incremental`. Pre-push = `pnpm test`. Never bypass git hooks with `--no-verify`.

Operator surface = dashboard (`/dashboard/{tokens,projects,sessions,judgments,memories,consolidation,maintenance}`). No operator CLI; Docker image runs the server only.

## Architecture

Single Node process, single SQLite file. Server layers at `apps/server/src/{server,mcp,dashboard,services,db,consolidation,llm}/`. Shared plugin tree at `apps/plugin/` ships to FOUR clients (Claude Code, Codex CLI, Hermes Agent, opencode) — see [Plugin development](#plugin-development-discipline). Monorepo uses pnpm workspaces with `apps/*` (deliverables) and `packages/*` (shared libraries — empty for now, staged for future extractions).

### Load-bearing invariants (do NOT violate without an OpenSpec change)

- **Append-only memory.** Rows never `DELETE`d (narrow purge exceptions in `apps/server/src/services/{memory,agent-sessions}.ts` and `apps/server/src/scripts/seed-dev.ts`, allow-listed in `apps/server/src/test/invariants.test.ts`). `content` never `UPDATE`d. Lifecycle = `status` flips (`active` → `superseded` | `archived`) plus `replaces` links. Every consolidation op journaled in `consolidation_ops`, reversible.
- **Scope enforced at service layer.** Every `MemoryService` query filters by `Scope`. Cross-scope reads return `not_found`. New MCP tools that need project scope MUST consult both `ctx.project` (URL slug) and `SessionRouter` (`project.use` calls) via `resolveEffectiveProject` / `scopeFromContext` — never read `ctx.project` in isolation.
- **Convergent topics via `topic_key`.** `saveWithTopicKey` atomically supersedes the previously-active row in the same `(scope, project_id, topic_key)`.
- **Fresh-context judgment.** Conflicts surface in `memory.save.candidates[]`; closed by `memory.judge`. Aged pendings re-surface in `memory.context.pendingJudgments[]`. The consolidation sweep is deterministic (decay + deadline orphaning, no LLM, no cron — runs throttled on session start).

Path-scoping contract (in `apps/server/src/mcp/tools.ts`): `/mcp/<slug>` rejects `scope='global'` with `scope_locked`; `/mcp` rejects `scope='project'` with `project_required` unless an active project exists.

### Data access pattern

- ALL SQL (Drizzle builder or raw) lives under `apps/server/src/db/`: one repository per aggregate in `db/repositories/`, DB-level introspection in `db/diagnostics.ts`. Services orchestrate (scope resolution, validation, transactions); dashboard handlers call `admin*` repository reads + service mutations. No SQL in services/dashboard/mcp/server.
- Never hand-write row/DTO shapes. Derive from schema types: `$inferSelect`/`$inferInsert` for entities, `Pick<Entity, …> & { … }` for join projections, schema-derived aliases (`MemoryStatus`, `RelationKind`) for filter params.

### Table-rebuild migrations (SQLite)

SQLite has no `ALTER TABLE … ADD CONSTRAINT`, `ALTER COLUMN`, or change-nullability. To add a `CHECK`, change a type, or flip NOT NULL you have to do the rebuild dance (`CREATE TABLE x_new (…)` → `INSERT … SELECT *` → `DROP TABLE x` → `ALTER TABLE x_new RENAME TO x` → recreate indexes/triggers). With `foreign_keys = ON` (the default set by `db/client.ts`), `DROP TABLE` on a parent of any populated child table fails with `FOREIGN KEY constraint failed`. `PRAGMA foreign_keys` cannot be changed inside a transaction, and `PRAGMA defer_foreign_keys` does **not** defer the DROP-TABLE check (it only defers per-row FK violations).

The migration runner (`apps/server/src/db/migrate.ts`) therefore wraps every migration in `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → migration body → `PRAGMA foreign_key_check` (pre-commit gate) → `COMMIT` → `PRAGMA foreign_keys = ON`. Migration authors do not need to add any pragma. The integrity gate runs `foreign_key_check` before COMMIT and aborts the transaction on any dangling reference, so disabling FKs around the body is safe. Enforced by `apps/server/src/test/invariants.test.ts::"migration runner FK-safety invariant"`.

## OpenSpec workflow

Behavioral changes are spec-driven. Specs in `openspec/specs/<area>/`; active proposals in `openspec/changes/<name>/`; archived in `openspec/changes/archive/`. **Before changing a load-bearing invariant or adding a new MCP tool, open an OpenSpec change first.**

## Dashboard conventions

- **Timestamps go through `formatTs`** (`apps/server/src/dashboard/templates.ts`). Emits `<time data-rembric-ts>…</time>`; layout shell upgrades to viewer's TZ. Never hand-write `toISOString` / `toLocaleString` in templates.
- **Destructive actions MUST use the `data-confirm` modal.** Attributes on the `<form>`, not the `<button>`. `data-confirm-tone="danger"` for irreversible, `"warn"` for reversible. Call sites to mirror: `apps/server/src/dashboard/{sessions,tokens,projects,memories,consolidation,maintenance}.ts`.
- **Nomenclature**: UI says `judgments`, DB/services/MCP say `relations`. Same row, two layers — don't propose to unify (recorded in `openspec/changes/archive/2026-05-17-refresh-dashboard-presentation/design.md` Decision 1).
- **Design tokens locked**: brutalist dark theme, lime accent, self-hosted fonts only. Changing tokens requires an OpenSpec change against `dashboard` spec. CSS lives in `apps/server/src/dashboard/styles/` — never inline `<style>` in templates.

## Code style

- TypeScript strict; no `any` / `as unknown as T` without a justifying comment.
- No floating promises (ESLint enforces).
- `import type` for types; imports ordered builtin → external → internal → relative (auto-fixed).
- Co-located tests `**/*.test.ts` (each workspace). Invariant tests under `apps/server/src/**/__tests__/invariants/` are sacred.
- **Default to no comments.** Comment only when absence costs a future reader real time (magic numbers, hidden invariants, library quirks, public-API docstrings). Never restate code or reference the current task/PR. **Banner/section-divider comments (`// ──────`, `// === API ===`), structural labels that just name the block below, and docstrings that paraphrase the signature are an anti-pattern — do not add them.** A licit comment documents one concrete non-obvious fact (a why, an invariant, an ordering constraint), nothing more.

## Skills

**Skills MUST be symlinked into `.claude/skills/`.** Source lives at `.agents/skills/<name>/`; the symlink is `ln -s ../../.agents/skills/<name> .claude/skills/<name>`. Without the symlink Claude Code's Skill tool doesn't surface it. Never write skill source directly inside `.claude/skills/`.

Two skills are mandatory consulting points:

- **`.agents/skills/npm-security-best-practices/`** — before adding any dependency or editing `package.json` / `.npmrc` / `pnpm-workspace.yaml` / lockfile / CI install / Dockerfile install layers. The repo enforces default-deny lifecycle scripts (`.npmrc::ignore-scripts=true`), explicit `pnpm-workspace.yaml::allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge: 4320`, and lockfile-lint in CI.
- **`.agents/skills/rembric-plugin-development/`** — before touching anything under `apps/plugin/`. Covers the four clients, per-client gotchas (`references/per-client-gotchas.md`), and the mandatory e2e validation against `pnpm run dev:docker:up` (`references/e2e-walkthrough.md`).

## Plugin development discipline

Full guide in the skill above. Hard rules to remember at all times:

- **`apps/plugin/bin/rembric-dotenv.mjs` is the ONLY JS/TS implementation** of `parseDotenv` + `readRembricSlug` + `SLUG_RE`. The bridge and the opencode plugin import it. Bash (`_api.sh`) and Python (Hermes) keep their own — cross-language wrapper > duplication. Invariant test in `apps/server/src/test/invariants.test.ts` enforces.
- **Per-component versioning.** Each `apps/plugin/.X-plugin/` is its own release-please component (`claude-code-plugin`, `codex-plugin`, `hermes-plugin`, `opencode-plugin`) with its own CHANGELOG via release-please. A fifth umbrella component `plugin-shared` watches everything in `apps/plugin/` outside the four manifest dirs (the shared `bin/`+`hooks/`+`commands/`+`scripts/`+`README.md`); its `path` is `apps/plugin` with `exclude-paths` filtering the per-client dirs. The `plugin-suite` linked-versions group keeps `plugin-shared`+`claude-code-plugin`+`codex-plugin`+`opencode-plugin` at the same version, so any commit touching shared assets cascades a bump to the three clients that consume them. `hermes-plugin` stays out of the group — it is self-contained (its `install.sh` only fetches `plugin.yaml`/`__init__.py`/`README.md` from `.hermes-plugin/`).
- **Session lifecycle is HTTP**, not MCP. Hooks (Claude+Codex) and in-process providers (Hermes, opencode) POST to `/api/<slug>/sessions(*)`. `memory.save` auto-attaches `session_id` via `resolveActiveSessionId` (`apps/server/src/mcp/tools.ts`); agents never thread it manually.
- **Sanity check before commit**: `git ls-files apps/plugin/` shows ONE copy of each shared resource. Legitimate divergences are the per-client manifest dirs (`.claude-plugin/`, `.codex-plugin/`, `.hermes-plugin/`, `.opencode-plugin/`) and `hooks/hooks{,.codex}.json`. Anything else duplicated is a sync bug.
