# CLAUDE.md

Guidance for Claude Code working in this repo. Specs in `openspec/specs/` are the authoritative contract; this file is the must-know-fast index.

## Quick reference

| Need             | Command / path                                                               |
| ---------------- | ---------------------------------------------------------------------------- |
| Install          | `pnpm install` (run `corepack enable` first)                                 |
| Typecheck / lint | `pnpm run typecheck` · `pnpm run lint`                                       |
| Tests            | `pnpm test` (single file: `pnpm vitest run path/to/file.test.ts`)            |
| Dev stack        | `pnpm run dev:docker:up` (foreground, wipes+reseeds; `docs/docker.md`)       |
| OpenSpec         | `/opsx:propose` · `/opsx:explore` · `/opsx:apply` · `/opsx:archive`          |
| Spec provenance  | `pnpm run check:spec-provenance` (only `origin/main...HEAD`; CI is the gate) |
| Mutation check   | `node scripts/mutate.mjs --file … --spec … --mutation … --with …`            |

Conventional Commits required (commitlint). Pre-commit = lint-staged + `tsc --noEmit --incremental`. Pre-push = `pnpm test`. Never bypass git hooks with `--no-verify`.

PR titles and descriptions are always written in English (regardless of the language used in chat).

Operator surface = dashboard (`/dashboard/{tokens,projects,sessions,judgments,memories,consolidation,maintenance}`). No operator CLI; Docker image runs the server only.

## Claims need evidence

A finding is not a finding until it has been executed. Scale the evidence to the cost of being wrong: the higher the consequence, the less an argument from reading the code is worth. This generalises the standard `db-performance-auditor` already applies to queries — measure the alternative, don't assume it.

- **Never publish what you have not run.** Issue comments, security advisories, PR descriptions and spec text are outward-facing; a wrong claim there has to be retracted in public.
- **A subagent's finding is a hypothesis.** Re-verify before acting on it or repeating it — subagents report plausible readings as results.
- **Probe the boundary the real caller uses, and include a control that must pass.** A probe that skips a layer proves nothing about it (calling an MCP handler directly bypasses its zod schema, so "the tool accepts X" measured that way is not a fact about the tool). With only a failing case you cannot tell a real defect from a broken probe; the control is what tells you which you have.
- **Classify from behaviour, not from the symptom's shape.** "The observable result changes" makes something a behaviour change; whether it is a _defect_ depends on whether the current behaviour is defensible — same evidence bar as anything else.
- **A new guard is not covered until its test fails without it.** Weaken each condition separately and confirm the tests naming it go red — `scripts/mutate.mjs` does the backup/mutate/run/restore loop. Three tests in one session passed while proving nothing (one asserted over an empty result set; two short-circuited before the condition they named), and only mutation found them. A test green on both sides of the change is the default outcome, not the exception.
- **One instrument per series, named.** Never present an isolated statement's timing and an end-to-end operation's timing as one table: a 39× statement speedup was a 2.5× user-facing one, and the ratio came from silently switching instruments between rows. State which you measured, and quote the end-to-end figure when a user waits on it.

Where a claim is about spec text rather than runtime, the evidence is the verbatim quote with `file:line`, never a paraphrase.

## Architecture

Single Node process, single SQLite file. Server layers at `apps/server/src/{server,mcp,dashboard,services,db,consolidation,llm}/`. Shared plugin tree at `apps/plugin/` ships to FOUR clients (Claude Code, Codex CLI, Hermes Agent, opencode) — see [Plugin development](#plugin-development-discipline). Monorepo uses pnpm workspaces with `apps/*` (deliverables) and `packages/*` (shared libraries — empty for now, staged for future extractions).

### Load-bearing invariants (do NOT violate without an OpenSpec change)

- **Append-only memory.** Rows never `DELETE`d (narrow purge exceptions in `apps/server/src/services/{memory,agent-sessions}.ts` and `apps/server/src/scripts/seed-dev.ts`, allow-listed in `apps/server/src/test/invariants.test.ts`). `content` never `UPDATE`d. Lifecycle = `status` flips (`active` → `superseded` | `archived`) plus `replaces` links. Every consolidation op journaled in `consolidation_ops`, reversible.
- **Scope enforced at service layer.** Every `MemoryService` query filters by `Scope`. Cross-scope reads return `not_found`. New MCP tools that need project scope MUST consult both `ctx.project` (URL slug) and `SessionRouter` (`project.use` calls) via `resolveEffectiveProject` / `scopeFromContext` — never read `ctx.project` in isolation.
- **Convergent topics via `topic_key`.** `saveWithTopicKey` atomically supersedes the previously-active row in the same `(scope, project_id, topic_key)`.
- **Fresh-context judgment.** Conflicts surface in `memory.save.candidates[]`; closed by `memory.judge`. Aged pendings re-surface in `memory.context.pendingJudgments[]`. The consolidation sweep is deterministic (decay + deadline orphaning, no LLM, no cron — runs throttled on session start).
- **Review state is derived, never stored.** Two orthogonal staleness axes: _decay_ (access + confidence, keyed on `last_seen_at` — the sweep archives) and _review_ (affirmation, keyed on `max(created_at, last confirmation) + per-type TTL` in `apps/server/src/services/review.ts`). `reviewState`/`needsReview` are computed at read time in `MemoryService`/repository reads — no column, no sweep, no new mutation verb. Re-affirming a `needs_review` memory is the existing `memory.confirm` (append-only event); reading it (`last_seen_at`) deliberately does NOT clear it.

Path-scoping contract (in `apps/server/src/mcp/memory-tools.ts`): `/mcp/<slug>` rejects `scope='global'` with `scope_locked`; `/mcp` rejects `scope='project'` with `project_required` unless an active project exists.

### Data access pattern

- ALL SQL (Drizzle builder or raw) lives under `apps/server/src/db/`: one repository per aggregate in `db/repositories/`, DB-level introspection (PRAGMA/dbstat/VACUUM/ping) in `db/diagnostics.ts`. Services orchestrate (scope resolution, validation, transactions); dashboard handlers call `admin*` repository reads + service mutations. No SQL in services/dashboard/mcp/server — grep-enforced by `invariants.test.ts` (data-access confinement).
- **Scope still resolved at the service layer.** Services compute the `Scope` (`resolveEffectiveProject`/`scopeFromContext`) and pass it down; scoped repository methods _require_ it as a parameter. Unscoped reads carry the `admin*` prefix and are callable ONLY from `src/dashboard/` (+ the dashboard router) — grep-enforced. Cross-scope service reads keep the `unsafe*` prefix.
- Services own `db.transaction()`; repositories never open transactions (single synchronous connection means repo calls inside a service tx participate automatically).
- Never hand-write row/DTO shapes. Derive from schema types: `$inferSelect`/`$inferInsert` for entities, `Pick<Entity, …> & { … }` for join projections, schema-derived aliases (`MemoryStatus`, `RelationKind`) for filter params.

### Table-rebuild migrations (SQLite)

SQLite has no `ALTER TABLE … ADD CONSTRAINT`, `ALTER COLUMN`, or change-nullability. To add a `CHECK`, change a type, or flip NOT NULL you have to do the rebuild dance (`CREATE TABLE x_new (…)` → `INSERT … SELECT *` → `DROP TABLE x` → `ALTER TABLE x_new RENAME TO x` → recreate indexes/triggers). With `foreign_keys = ON` (the default set by `db/client.ts`), `DROP TABLE` on a parent of any populated child table fails with `FOREIGN KEY constraint failed`. `PRAGMA foreign_keys` cannot be changed inside a transaction, and `PRAGMA defer_foreign_keys` does **not** defer the DROP-TABLE check (it only defers per-row FK violations).

The migration runner (`apps/server/src/db/migrate.ts`) therefore wraps every migration in `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → migration body → `PRAGMA foreign_key_check` (pre-commit gate) → `COMMIT` → `PRAGMA foreign_keys = ON`. Migration authors do not need to add any pragma. The integrity gate runs `foreign_key_check` before COMMIT and aborts the transaction on any dangling reference, so disabling FKs around the body is safe. Enforced by `apps/server/src/test/invariants.test.ts::"migration runner FK-safety invariant"`.

## OpenSpec workflow

Behavioral changes are spec-driven. Specs in `openspec/specs/<area>/`; active proposals in `openspec/changes/<name>/`; archived in `openspec/changes/archive/`. **Before changing a load-bearing invariant or adding a new MCP tool, open an OpenSpec change first.**

Each phase has a dedicated subagent, so a phase can be delegated whole — see [Agents](#agents).

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

- **`.agents/skills/npm-security-best-practices/`** — before adding any dependency or editing `package.json` / `.npmrc` / `pnpm-workspace.yaml` / lockfile / CI install / Dockerfile install layers. The repo enforces default-deny lifecycle scripts (`.npmrc::ignore-scripts=true`) with per-package exceptions enumerated only in `pnpm-workspace.yaml::allowBuilds`, pinned by `ALLOWED_BUILD_SCRIPTS` (`grep -rn ALLOWED_BUILD_SCRIPTS`) — adding a `true` entry reds `pnpm test` until the inventory is edited too, and so does a `pnpm rebuild` argument in the Dockerfile that the inventory does not pin. For the rest of the posture (`blockExoticSubdeps`, `minimumReleaseAge`, what `--frozen-lockfile` actually guarantees) read `CONTRIBUTING.md#adding-a-dependency` — do not restate it here.
- **`.agents/skills/rembric-plugin-development/`** — before touching anything under `apps/plugin/`. Covers the four clients, per-client gotchas (`references/per-client-gotchas.md`), and the mandatory e2e validation against `pnpm run dev:docker:up` (`references/e2e-walkthrough.md`).
- **`.agents/skills/rembric-tui-installer/`** — the installer contract/reference (orchestrator model, canonical single path, what-not-to-break). Consult before changing `install.sh`, the root shim, per-client install/uninstall, or distribution docs.
- **`.agents/skills/rembric-tui-installer-e2e/`** — the runnable e2e validation playbook for the installer. Run before merging/deploying any install/distribution change.

## Agents

**Agent source lives at `.agents/agents/<name>.md`.** Unlike skills (one symlink per skill), the whole directory is symlinked once — `.claude/agents -> ../.agents/agents` — so adding an agent needs no symlink step, just a new file. Per-file symlinks would also break `lint-staged`, which passes staged paths to `prettier` explicitly and prettier refuses an explicitly-named symlink.

One agent per OpenSpec phase, so a phase can be delegated whole. Each invokes its phase's skill and carries this repo's invariants, so the delegating session doesn't have to re-explain them. They run non-interactively and therefore **must be given the change name** — they will stop rather than guess.

| Agent          | Phase   | Skill it invokes          | Writes                                   |
| -------------- | ------- | ------------------------- | ---------------------------------------- |
| `sdd-explorer` | explore | `openspec-explore`        | nothing — findings + open questions only |
| `sdd-proposer` | propose | `openspec-propose`        | `openspec/changes/<name>/**` only        |
| `sdd-applier`  | apply   | `openspec-apply-change`   | source, ticking `tasks.md` as it lands   |
| `sdd-archiver` | archive | `openspec-archive-change` | merges delta specs, moves to `archive/`  |

Plus one specialist:

- **`db-performance-auditor`** — SQLite query and schema performance. Proves every finding with `EXPLAIN QUERY PLAN` plus wall-clock at 1k/20k/50k rows, ranks by `call frequency × measured cost`, and **measures the proposed alternative** rather than assuming it (a `LEFT JOIN` rewrite assumed to be the obvious fix here turned out to be a pessimisation at 50k). Read-only: it never modifies a tracked file. Use it before adding an index or rewriting a query, not just when something is already slow.

## Plugin development discipline

Full guide in the skill above. Hard rules to remember at all times:

- **`apps/plugin/bin/rembric-dotenv.mjs` is the ONLY JS/TS implementation** of `parseDotenv` + `readRembricSlug` + `SLUG_RE`. The bridge and the opencode plugin import it. Bash (`_api.sh`) and Python (Hermes) keep their own — cross-language wrapper > duplication. Invariant test in `apps/server/src/test/invariants.test.ts` enforces.
- **Two independent release tracks (`server` + unified `plugin`).** release-please runs exactly two components, with **no** `node-workspace`/`linked-versions`/grouping plugin: `server` (`apps/server`, package `@rembric/server`, tag `server-v*`, Docker image) and **`plugin`** (`apps/plugin` — the WHOLE tree, no `exclude-paths`, package `@rembric/plugin`, tag `plugin-v*`). The `plugin` component carries **one unified version shared by all four clients**; its `extra-files` update every client version carrier in lock-step (`.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, `.opencode-plugin/plugin.ts` comment). A change to ANY plugin file bumps the single `plugin` version (a Claude-only fix bumps the shared number; the CHANGELOG, scoped by conventional commit, says what actually changed). Plugin releases NEVER rebuild the server image (`publish-docker` gates on `server_release_created`). There is **no cascade and no anchor-tag dependency** — the six-component + `node-workspace` model was retired (change `unify-plugin-release-track`) after its cascade/anchor fragility caused phantom release PRs. `release-please.yml` has a `concurrency` guard (`cancel-in-progress: false`) so a rapid second merge never cancels tag-minting. Tags: `server-v*`, `plugin-v*` (legacy per-client `*-plugin-v*` tags stay in history, inert).
- **Session lifecycle is HTTP**, not MCP. Hooks (Claude+Codex) and in-process providers (Hermes, opencode) POST to `/api/<slug>/sessions(*)`. `memory.save` auto-attaches `session_id` via `resolveActiveSessionId` (`apps/server/src/mcp/memory-tools.ts`); agents never thread it manually.
- **Sanity check before commit**: `git ls-files apps/plugin/` shows ONE copy of each shared resource. Legitimate divergences are the per-client manifest dirs (`.claude-plugin/`, `.codex-plugin/`, `.hermes-plugin/`, `.opencode-plugin/`) and `hooks/hooks{,.codex}.json`. Anything else duplicated is a sync bug.
- **The TUI is the single install/maintenance path.** Install / setup / upgrade / uninstall of the server + every client plugin is done via the TUI installer (`apps/plugin/install.sh`, fronted by the repo-root `install.sh` shim — canonical URL `.../main/install.sh`). Per-client commands (marketplace, per-client `curl|sh`, manual Docker quickstart) are the TUI's backend and documented ONLY as manual fallback. Any change touching install/distribution MUST first verify it doesn't break the installer — run the `rembric-tui-installer-e2e` playbook (`install.test.ts` headless + the local/pty layers) before landing. See the `rembric-tui-installer` skill for the contract.
