## Why

Curated user prompts (`prompts` table, populated by `memory.save_prompt`) have no operator surface and an anaemic read API: today they are write-only from the agent's perspective except for the recency window inside `memory.context.recentPrompts` (hard-capped at 50, no search, no filters, no by-id retrieval), and they are completely invisible in the dashboard. The data is captured but unusable. Without a way to retrieve, refine, or clean up prompts, the act of saving them adds little value — and the existing session-detail page omits them entirely even though the schema already carries `prompts.session_id`.

This change adds the operator surface (list view, soft-delete, maintenance purge, session-detail integration) and the agent retrieval surface (FTS5 + `memory.search_prompts`) without violating the append-only invariant. It also introduces a minimal refine mechanism (`replaces` link in `memory.save_prompt`) so an agent can supersede a stale prompt atomically when the user clarifies a goal, mirroring the soft-delete-old + save-new workflow in a single MCP call.

## What Changes

- **Dashboard**
  - New top-level view at `/dashboard/prompts` listing prompts with pagination, filters (project · session · agent · free-text FTS), Delete + Undelete row actions, and `?include_deleted=1` toggle.
  - Session detail (`/dashboard/sessions/:id`) gains a new `Prompts (N)` section below the existing `Memories (N)` section.
  - Sessions list (`/dashboard/sessions`) gains a new `prompts` count column alongside `memories`.
  - Maintenance page (`/dashboard/maintenance`) gains a third card "Purge deleted prompts" (danger tone, irreversible).
  - New sidebar nav entry `PROMPTS` (MAIN group, between `JUDGMENTS` and `CONSOLIDATION`, num=`03b`).
- **Schema**
  - Add `prompts.deleted_at` (timestamp_ms, nullable) for operator soft-delete.
  - Add `prompts.title` (text, nullable, ≤100 chars) for retrieval-efficient lists.
  - Add `prompts.tags` (text JSON array, nullable, same shape as `memory.tags`) for categorical filtering and FTS5 enrichment.
  - Add `prompts.replaces` (text JSON array, nullable) for refine chains.
  - Fix the misleading docstring "Records what the user asked" → "Records curated, reusable user prompts (goals, constraints, directives)."
- **FTS5**
  - New `prompts_fts` virtual table contentless mirror over `prompts`, indexing `content` + flattened `tags`, with `AI` / `AU` / `AD` triggers identical in shape to `memory_fts`.
- **Service layer**
  - `PromptsService.save` accepts optional `title`, `tags`, `replaces`; when `replaces` is provided it runs an atomic tx that validates and soft-deletes the referenced predecessor + inserts the new row with `replaces=[oldId]`.
  - New methods: `softDelete(id, opts)`, `undelete(id, opts)`, `purgeDeleted({ adminBypass:true })`, `searchByScope({ scope, query?, sessionId?, agent?, includeDeleted?, limit, offset })`.
  - `recentForContext()` now filters `deleted_at IS NULL`.
- **MCP**
  - `memory.save_prompt` schema extended with optional `title`, `tags`, `replaces` (predecessor id).
  - New tool `memory.search_prompts` with FTS5-backed search + structured filters, scope-resolved via the existing `scopeFromContext` helper.
  - `initialize.instructions` crib sheet is NOT modified (tools/list remains the discovery mechanism for the new tool).
- **Invariants**
  - `apps/server/src/test/invariants.test.ts` allow-lists `DELETE FROM prompts` ONLY from `services/prompts.ts::purgeDeleted` (positive assertion that the file contains the statement, so the relaxation can't expire silently).
  - Empty-session purge predicate is RELAXED: "no row exists in `prompts` with `session_id = sessions.id`" → "no row exists in `prompts` with `session_id = sessions.id` AND `deleted_at IS NULL`". Soft-deleted prompts no longer block session purge.
  - Append-only invariant on `prompts.content` is preserved — content is never UPDATEd; lifecycle is `deleted_at` flips + `replaces` links.

## Capabilities

### New Capabilities

None. All changes modify existing specs.

### Modified Capabilities

- `dashboard`: new `/dashboard/prompts` view + prompts column on sessions list + prompts section on session detail + Purge deleted prompts card on maintenance + new sidebar entry.
- `mcp-api`: new `memory.search_prompts` tool; extended `memory.save_prompt` input schema with optional `title` / `tags` / `replaces`.
- `sessions`: `memory.search_prompts` added to the documented list of tools that consult `scopeFromContext`; empty-session purge predicate relaxed to ignore soft-deleted prompts.
- `persistence`: new `prompts_fts` virtual table; new `prompt_purge` op_type in `consolidation_ops`; `prompts` listed alongside the other operator-visible tables for the bootstrap data-loss guard.

## Impact

**Server source**

- `apps/server/src/db/schema/prompts.ts` — add columns + fix docstring.
- `apps/server/src/db/migrations/0005_prompts_extend.sql` — NEW (ALTER TABLE for `deleted_at`, `title`, `tags`, `replaces`).
- `apps/server/src/db/migrations/0006_prompts_fts.sql` — NEW (virtual table + 3 triggers).
- `apps/server/src/services/prompts.ts` — extend save, add softDelete/undelete/purgeDeleted/searchByScope; recentForContext filter.
- `apps/server/src/services/agent-sessions.ts` — update `purgeEmpty` predicate to ignore deleted prompts.
- `apps/server/src/mcp/sessions-tools.ts` — extend savePromptSchema; add searchPromptsSchema + handler.
- `apps/server/src/mcp/server.ts` — register `memory.search_prompts`; update `memory.save_prompt` description.
- `apps/server/src/dashboard/prompts.ts` — NEW.
- `apps/server/src/dashboard/sessions.ts` — add prompts count column + prompts section in detail.
- `apps/server/src/dashboard/maintenance.ts` — add Purge deleted prompts card + handler.
- `apps/server/src/dashboard/components.ts` — extend NavKey, NAV, NAV_ICONS.
- `apps/server/src/server/dashboard-router.ts` — mount `/prompts` router.
- `apps/server/src/dashboard/styles/views/prompts.css` — NEW.
- `apps/server/src/test/invariants.test.ts` — allow-list `DELETE FROM prompts` from `purgeDeleted`.

**Spec deltas**

- `openspec/changes/add-prompts-dashboard-view/specs/dashboard/spec.md`
- `openspec/changes/add-prompts-dashboard-view/specs/mcp-api/spec.md`
- `openspec/changes/add-prompts-dashboard-view/specs/sessions/spec.md`
- `openspec/changes/add-prompts-dashboard-view/specs/persistence/spec.md`

**Tests**

- New: `prompts.test.ts` (save with title/tags/replaces, softDelete/undelete, purgeDeleted, searchByScope FTS5).
- New: `sessions-tools.test.ts` coverage for `memory.search_prompts` scope resolution + refine flow.
- Updated: `invariants.test.ts` for new allow-list entry.
- Updated: `agent-sessions.test.ts` for relaxed empty-session predicate.

**No impact on**

- Plugin clients (Claude Code, Codex CLI, Hermes, opencode) — schema additions on `memory.save_prompt` are backward-compatible (all new fields optional); no client code changes required.
- Append-only invariant on `prompts.content` (preserved).
- `topic_key` / `status` enum on prompts (explicitly deferred).
- 800-char crib sheet in `initialize.instructions`.
