## 0. Project identity — slug rename + header removal

- [x] 0.1 Rename `projects.path` column to `projects.slug` via `ALTER TABLE projects RENAME COLUMN path TO slug` in migration `0003_sessions_and_slugs.sql`
- [x] 0.2 Update Drizzle schema in `src/db/schema/projects.ts` to reflect the rename (field name `slug`, same constraints)
- [x] 0.3 Replace `ProjectsService.findOrCreate(path)` with `findBySlug(slug)` and `create({slug, displayName?})`; the latter validates `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` and rejects with `invalid_slug` otherwise
- [x] 0.4 Implement `findSimilarSlugs(input, limit=3)` — Levenshtein distance ≤ 3 over the slugs table, deterministic, no LLM
- [x] 0.5 Refactor all consumers of `findOrCreate` (`src/server/auth.ts`, dashboard token form, CLI token-cli, dashboard memories filter, mcp/tools) to call `findBySlug` + explicit `create` only where appropriate; tools-driven flows MUST NOT auto-create
- [x] 0.6 Remove the `X-Rembric-Project` header from `src/server/http.ts`'s `authenticate()` path; remove the test that asserts header equivalence; add a release-note bullet
- [x] 0.7 Update `src/dashboard/projects.ts` and templates to render `slug` (label "Slug"); flag rows whose value does not match the strict regex with a non-blocking "legacy slug" badge
- [x] 0.8 Update existing tests (`projects.test.ts`, `mcp/tools.test.ts`, `dashboard-e2e.test.ts`) to assert the new naming, the rejection of invalid slugs, and the absence of header-based scoping
- [x] 0.9 Update `EXPECTED_COLUMNS` in `schema-drift.test.ts` (the `path` column is renamed to `slug`)

## 1. Persistence — sessions table and FKs

- [x] 1.1 Add Drizzle schema for `sessions` (`id`, `tokenId` FK, `projectId` FK nullable, `agent`, `description`, `startedAt`, `endedAt`, `summary`, `status` enum `active|ended|abandoned`)
- [x] 1.2 Add nullable `sessionId` FK column to `memory` schema
- [x] 1.3 Add nullable `sessionId` FK column to `confirmations` schema
- [x] 1.4 Generate migration `0003_sessions.sql` via `drizzle-kit generate` and verify forward-only application against the existing v0 DB
- [x] 1.5 Update `EXPECTED_TABLES` / `EXPECTED_COLUMNS` in `schema-drift.test.ts` to include the new table and columns
- [x] 1.6 Extend the append-only invariant grep (`src/test/invariants.test.ts`) to forbid `DELETE FROM sessions` and `UPDATE sessions SET (agent|started_at|token_id) =`
- [x] 1.7 Add a startup hook that flips `sessions.status='active'` rows older than `SESSION_ABANDON_AFTER_MS` (default `86_400_000`) to `'abandoned'` with `endedAt=now`
- [x] 1.8 Add config knob `SESSION_ABANDON_AFTER_MS` (zod, default 24h) with tests

## 2. Service layer — `SessionsLifecycleService`

- [x] 2.1 Implement `start({ tokenId, projectId, agent, description })` → inserts a row, returns the session
- [x] 2.2 Implement `end(sessionId, { tokenId })` — refuses when `token_id` mismatches, refuses double-end with code `session_already_ended`
- [x] 2.3 Implement `summarize(sessionId, { tokenId, summary })` — same auth check, sets `summary`, `endedAt`, `status='ended'` atomically
- [x] 2.4 Implement `findActiveForTransport({ tokenId, projectId })` — returns the most-recently-started active session for the pair (or null)
- [x] 2.5 Implement `recentForContext({ scope, limit })` — returns the N most recent sessions for the request scope
- [x] 2.6 Implement `abandonStale({ olderThanMs })` — bulk update used by the startup hook
- [x] 2.7 Unit tests for each method, covering the cross-token rejection case
- [x] 2.8 Extend `MemoryService.save` to stamp `sessionId` from the active routing context when not explicitly provided (purely additive — the existing signature stays the same)

## 3. Request-scoped session routing

- [x] 3.1 Extend `RequestContext` to carry `mcpSessionId` (read from the `mcp-session-id` header)
- [x] 3.2 Add an in-process `SessionRouter` Map keyed by `(tokenId, projectId, mcpSessionId)` → `rembricSessionId`
- [x] 3.3 Hook `memory.session_start` to populate the router; hook `memory.session_end` / `memory.session_summary` to clear it
- [x] 3.4 Wire `MemoryService.save` to look up the router via `RequestContext` when no `sessionId` is passed
- [x] 3.5 Tests asserting two concurrent transport sessions (same token, different mcp-session-id) keep independent active sessions

## 4. MCP tools — lifecycle and research

- [x] 4.1 Register `memory.session_start` with zod schema `{ agent?, description?, project? }`; when `project` is supplied, validate it as a slug, reject `project_not_found` with suggestions if missing; on `/mcp/<slug>` URL, reject `scope_locked` if `project` mismatches the path
- [x] 4.2 Register `memory.session_end` with zod schema `{ sessionId? }` (defaults to router lookup)
- [x] 4.3 Register `memory.session_summary` with zod schema `{ sessionId?, summary }`
- [x] 4.4 Register `memory.context` with zod schema `{ sessions?, prompts?, memories?, includeArchived? }`; backend reads from `SessionsLifecycleService`, `UserPromptsService`, and `MemoryService.search`
- [x] 4.5 Register `memory.timeline` with zod schema `{ memoryId, before?, after? }`; document fallback in description
- [x] 4.6 Register `memory.capture_passive` with zod schema `{ text, sessionId? }`; parser: case-sensitive `^## Key Learnings:` heading + numbered/bulleted items until next H2 or EOF; emits one `memory.save` per item with `type='discovery'`
- [x] 4.7 Register `memory.doctor` (read-only, returns the JSON report)
- [x] 4.8 Register `memory.stats` (read-only, returns counters)
- [x] 4.9 Rewrite the descriptions for `memory.save`, `memory.search`, `memory.get`, `memory.confirm` in protocol-teaching style (lead with "Call this WHEN …")
- [x] 4.10 Add `_prompts` table + service to persist agent prompts (needed for `memory.context.recentPrompts`); register schema + migration `0004_prompts.sql`

## 4bis. Project tools and `roots`-based auto-detection

- [x] 4b.1 Register `project.use` with zod schema `{ slug: string, autocreate?: false, confirmSwitch?: false }`; enforce strict-slug regex on autocreate; reject with `project_not_found` + `suggestedSlugs[]` when missing; reject with `project_switch_requires_confirm` when switching without flag; reject with `session_active_must_end` when a session is active
- [x] 4b.2 Register `project.list` with zod schema `{ includeArchived?: false }`; return `{ projects: [{ slug, displayName, archived, memoryCount }] }`
- [x] 4b.3 Register `project.current` returning `{ slug, projectId, source, suggestedSlugs }`; `source` from the session router's resolution tag
- [x] 4b.4 Extend `SessionRouter` to carry `projectResolutionSource` (`'url-path' | 'roots' | 'tool-explicit' | 'none'`) and `pendingSuggestedSlugs[]` for the current MCP transport session
- [x] 4b.5 Implement `rootsDiscovery(ctx)` helper: after `initialized`, if no path slug, query the client's `roots/list` (2s timeout, silent on error), derive a slug from `basename(first.uri)` (lowercase, `[a-z0-9-]+` normalization), then either activate-if-exists-and-no-active-project, or push to `pendingSuggestedSlugs`
- [x] 4b.6 Hook the MCP server factory to invoke `rootsDiscovery` once per session, AFTER `initialized` (use the SDK's `oninitialized` callback)
- [x] 4b.7 Listen for `notifications/roots/list_changed` and re-run `rootsDiscovery` — updates `pendingSuggestedSlugs` only, never auto-switches
- [x] 4b.8 Update `instructions` builder to advertise `project.use`/`project.current` for unscoped `/mcp` connections; drop any mention of `X-Rembric-Project` header in path-scoped instructions
- [x] 4b.9 Tests: roots-based activation for existing slug; non-existing slug surfaces as suggestion; client without roots stays global; roots timeout falls through silently; mid-session list_changed updates suggestions but does not switch; idempotent `project.use` with same slug
- [x] 4b.10 Tests for `findSimilarSlugs` against a fixture of 100 slugs: deterministic, ≤3 results, distance ≤ 3

## 5. MCP initialize instructions

- [x] 5.1 Implement `buildInstructions(ctx)` helper that returns the scope-aware protocol-teaching block (≤ 800 chars)
- [x] 5.2 Wire `createMcpServer` to call `buildInstructions` and pass the result to `new McpServer({ instructions })`
- [x] 5.3 Update `McpTransportManager.serverFactory` to receive the request context so the variant matches the connection
- [x] 5.4 Unit test asserting both variants are ≤ 800 characters
- [x] 5.5 Unit test asserting both variants reference at least `memory.save`, `memory.search`, `memory.session_summary`
- [x] 5.6 Integration test using the official MCP SDK Client asserting `getServerVersion()` returns the project-scoped instructions string against `/mcp/<slug>` and the global one against `/mcp`

## 6. Dashboard surface

- [x] 6.1 Add `/dashboard/sessions` list route in a new `src/dashboard/sessions.ts` router
- [x] 6.2 Add `/dashboard/sessions/:id` detail route (metadata + summary + memories table)
- [x] 6.3 Mount the router under `/dashboard` and add a "Sessions" nav item in `templates.ts`
- [x] 6.4 Add `sessions (active)` stat card to the home overview
- [x] 6.5 E2E tests in `dashboard-e2e.test.ts` covering list, detail, and the "revoked token" rendering

## 7. CLI

- [x] 7.1 Extend `rembric status` JSON output to include `sessions: { active, ended, abandoned }`
- [x] 7.2 Add `rembric session list` (optional convenience; reads from the DB read-only, prints a table)

## 8. Documentation

- [x] 8.1 Update `docs/agents.md` to describe the new tools and the session protocol an operator paste-installs into agents that lack `instructions` support
- [x] 8.2 Update README "More docs" section if a new page is added
- [x] 8.3 Add a short note in `docs/troubleshooting.md` for the symptom "agent never calls memory.session_summary" (likely client ignores `instructions` + tool descriptions; check `tools/list`)

## 9. Tests — integration + regression

- [x] 9.1 Extend `mcp-integration.test.ts` with: session_start → save (server stamps session_id) → session_summary → context returns the new session
- [x] 9.2 Add a test asserting `memory.save` without `session_start` still works and the row has `session_id = NULL`
- [x] 9.3 Add a test for the timeline fallback (memory with null session_id returns time-window neighbors)
- [x] 9.4 Add a test for capture_passive: input with three numbered learnings → 3 memories saved with `type='discovery'`
- [x] 9.5 Add a test for doctor: shutdown the LLM stub, observe `llm.reachable: false` and a warning string
- [x] 9.6 Add a property-based test (fast-check) for the `## Key Learnings:` parser: random whitespace / blank lines / mixed list markers
- [x] 9.7 Update `properties.test.ts` to add the FSM legal transitions for sessions (`active → ended`, `active → abandoned`)
