# Refresh AGENTS.md and skills after the migration

## Why

The Hono→Next.js + Turborepo migration deleted `apps/server`, moved code to `apps/web` and `packages/{db,core,mcp,ui}`, and changed conventions (e.g. the owner's decision to drop narrative comments/JSDoc). `AGENTS.md` and the repo-vendored skills still reference old paths and old rules, so future sessions get stale instructions.

## Scope (queued last, after the comment sweep lands)

1. **`AGENTS.md`**: every path that names `apps/server/…` (invariants tests → `apps/web/src/test/`, dashboard conventions → `apps/web/src/…`, dashboard styles location, data-access confinement roots, quick-reference commands); the code-style "comments" section rewritten to the owner's new convention (no narrative comments/JSDoc; ESLint/TS directives and cast justifications only); OpenSpec workflow references; any mention of Hono-era architecture.
2. **`.agents/skills/*`**: `rembric-dashboard-ui` (references `src/dashboard/`), `rembric-smoke-tests` (references `apps/server/src/server/api-router.ts`, MCP tools path), `rembric-plugin-development` (client paths, shared modules now under apps/plugin unchanged?), `npm-security-best-practices` (references `apps/server/src/test/invariants.test.ts`), `rembric-tui-installer*`, `diagnose`, `testing`, `zero-tech-debt` — check each SKILL.md for stale paths/commands and the migration-era architecture assumptions. Verify `.claude/skills/` symlinks still resolve (`ln -s ../../.agents/skills/<name>`).
3. **`.agents/instructions/*`**: e.g. `db-performance-auditor.md` — check for `apps/server` references.
4. **`openspec/`**: project.md / specs referencing apps/server layout, if any.
5. Cross-check every corrected path actually exists on disk (no invented fixes); list anything uncertain instead of guessing.

## Execution

Read-only audit first (one scout mapping every stale reference with file:line), then one writer applying corrections + the skill-registry re-index, then aggregate check (markdown link/path greps, `pnpm run check:spec-provenance` unaffected, no code changes). Commit + push as `docs: refresh AGENTS.md and skills for the Next.js layout`.

## Tasks

- [ ] D1 Scout: inventory stale references across AGENTS.md, .agents/skills/, .agents/instructions/, openspec/ with file:line and proposed correction each.
- [ ] D2 Writer: apply corrections per inventory; re-check symlinks; update the code-style comments convention.
- [ ] D3 Verify: grep for remaining `apps/server` references that should have moved (excluding historical archive/spec provenance), report leftovers.
