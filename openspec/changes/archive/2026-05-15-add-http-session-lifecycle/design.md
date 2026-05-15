## Context

Rembric ships a `sessions` capability and a `/dashboard/sessions` view, but neither sees traffic in practice. Forensics (verified in current main, commit `622fa8b`):

- `plugin/scripts/session-start.sh` (5 LOC) only echoes a nudge to `memory.context`. It does NOT call any session lifecycle endpoint.
- `src/mcp/instructions.ts` injects ≤800 chars of system prompt at MCP `initialize`. It mentions `memory.save`, `memory.search`, `memory.session_summary` — **not** `memory.session_start`. The agent has no instruction to open sessions.
- The MCP tool `memory.session_start` is declared but, in Claude Code, deferred at the harness level (`<system-reminder>` lists `memory_session_start` among deferred tools). Even if the agent decides to open one, it must first `ToolSearch` the tool schema.
- The PreCompact hook in `plugin/hooks/hooks.json` is declared as `type: mcp_tool` calling `memory.session_summary({auto: true})`. The Zod schema in `src/mcp/sessions-tools.ts:39-42` requires `summary: z.string().min(1)` and rejects unknown keys. The `auto:true` field never made it from spec (`openspec/specs/claude-code-plugin/spec.md:51,79`) into code, so PreCompact silently fails — and on top of that, there is no active session for it to summarize anyway.

Engram (`https://github.com/Gentleman-Programming/engram`, 3.5k stars on GitHub) solves the same problem by inverting the responsibility: the hook reads Claude Code's host `session_id` from stdin and POSTs to its server's HTTP API. The agent does nothing. Engram's `session-start.sh` is ~100 LOC; Rembric's would be ~25 LOC after factoring out a shared helper.

We are adopting Engram's lifecycle approach, adapted to Rembric's invariants (per-token scope, append-only, slug-based path-scoping).

## Goals / Non-Goals

**Goals:**

- `/dashboard/sessions` becomes useful — every Claude Code or Codex session leaves a row.
- Cross-system observability: the session id shown in the Rembric dashboard equals the host `session_id` shown by `claude --status` or Codex's equivalent.
- Eliminate the `PreCompact` schema bug by replacing the broken `mcp_tool` call with a `command` script that writes a real summary string.
- Make session lifecycle independent of agent diligence — hooks do the work, the agent only needs to call `memory.save`/`memory.search`.
- Preserve all current MCP tools (`memory.session_start`, `memory.session_end`, `memory.session_summary`) for clients that do not run the plugin (raw HTTP, custom integrations).
- Cross-client by construction: the same scripts and HTTP endpoints support Claude Code, Codex, and any future client that supports `command`-type hooks.

**Non-Goals:**

- Solving Claude Code's tool deferral (the agent still has to `ToolSearch` to load `memory.save`, etc.). That's an independent problem and may be tackled in a follow-up change.
- Injecting a heavy ~600-token "Memory Protocol" block on every SessionStart, Engram-style. Conflicts with the existing doctrine (`memory-feedback-no-comments`, `claude-code-plugin/spec.md` token budget of ≤75 tok always-on).
- SubagentStop passive capture, adaptive save nudges, or `/projects/migrate` — separate features, separate changes.
- Reconciling Rembric's session-id semantics with `mcp-session-id` (the HTTP transport id used by `SessionRouter`). They remain orthogonal: `mcp-session-id` keys the in-memory router; the new `agent_sessions.id` is the Claude/Codex host-session id. Memory rows attach to the latter via the fallback resolution described below.

## Decisions

### 1. Path-scoped HTTP endpoints `/api/<slug>/sessions(*)` over body-pinned `POST /api/sessions {project: '<slug>'}`

Alternative considered: Engram-style body-pinned endpoint where the project is in the body. Rejected because Rembric already has a strongly enforced path-scope convention at `/mcp/<slug>` and the existing `authenticate({pathSlug})` helper validates token-vs-project scope as a side effect of path resolution. Reusing that helper for `/api/<slug>/sessions` means zero new auth logic, identical error codes, and identical scope semantics. Body-pinned would require parallel auth validation in every endpoint.

The chosen layout also makes path-less `/api/sessions` (no slug) cleanly reject as `not_found`, which matches the intent: this change only handles project-scoped sessions. Global-scope sessions remain accessible via the MCP `memory.session_start` tool for callers who need them.

### 2. Client-provided id, kept globally unique (pivoted from composite PK)

Original plan: composite PK `(token_id, id)` so two tokens could share an id. **Pivoted during implementation** after discovering that migration `0003_sessions_and_slugs.sql:45` declares `memory.session_id REFERENCES sessions(id)` at the SQL level. Changing the PK to composite would invalidate this FK (SQLite requires FK targets to be PK or UNIQUE), forcing a rebuild of the `memory` table — by far the largest table in Rembric. Cost dramatically exceeded the benefit (~10^-36 collision probability with modern UUID/ULID clients).

Revised approach:

- `sessions.id` stays as `TEXT PRIMARY KEY` (single column, globally unique). Zero schema change.
- `AgentSessionsService.start({id})` does a `SELECT WHERE id = ?` first. If found and `token_id` matches: idempotent return. If found and `token_id` differs: throw `id_collision`. If not found: `INSERT`. Three queries instead of one `INSERT OR IGNORE`, but session creation is not a hot path.
- HTTP endpoint maps `id_collision` → `409`.

Trade-off accepted: a malicious actor with a valid token could in principle "claim" an id another user might later try to use — but: (a) ids are high-entropy random, so collision requires precognition, and (b) that actor already has a valid token of their own and can do anything they could do by hijacking. Threat model unaffected.

The regex `/^[A-Za-z0-9_-]{8,128}$/` is a defensive floor: rejects empty strings, NUL bytes, accidental URL-encoded ids, and absurdly long inputs. UUIDs (36 chars), ULIDs (26 chars), and arbitrary hex/base64 ids all pass.

### 3. PreCompact: `mcp_tool` → `command` script

Alternative considered: Fix the schema to accept `{auto: true}` and have the server generate the summary from recent memory rows in that session window. Rejected because (a) the agent at the time of PreCompact has more context than the server (the LLM-side compact transcript is the canonical summary source, not a post-hoc reconstruction from saved rows), and (b) `mcp_tool` hooks have a strict argument JSON with no access to `session_id` or the compact transcript from stdin — only `command` hooks can read stdin. Switching to `command` unblocks the hook reading the real summary text Claude generates and POSTing it verbatim.

### 4. Add a single `Stop` hook, drop `PostCompact`

Alternative considered: Keep PostCompact as a nudge for `memory.context`. Rejected because `SessionStart` already fires on the `compact` matcher in Claude Code (verified in Engram's `hooks.json` and in Claude Code docs), making PostCompact redundant. Removing it saves ~30 tokens per compaction and reduces the surface area Codex has to mirror differently.

Adding `Stop` is necessary to mark sessions ended when the user closes the Claude Code window without compaction — otherwise sessions accumulate in `active` until the 24h abandonment sweep catches them.

### 5. Memory→session attachment via fallback resolution in MCP handlers, not via SessionRouter

Alternative considered: Have the hook POST also populate `SessionRouter` somehow. Rejected because the router is keyed by `(tokenId, mcpSessionId)` and the hook has no `mcp-session-id` — there's no MCP transport yet at SessionStart time, only the bridge's eventual connection later.

The chosen approach: when a `memory.save` (or other MCP tool) needs the active session id, it checks `SessionRouter` first (for explicit `memory.session_start` callers); if no entry exists, it falls back to "most recently active row in `agent_sessions` for `(token_id, project_id)`". This works because the hook just created exactly that row a moment ago. The fallback is bounded (must have `status='active'` and most recent `started_at`), so abandoned/stale rows don't capture saves.

### 6. Shared `_api.sh` helper, single set of hook scripts cross-client

Alternative considered: Per-client scripts (`session-start-claude.sh`, `session-start-codex.sh`). Rejected because the only legitimate per-client divergence today is the stdin JSON shape (and even that may not differ — Codex's actual shape is TBD; the spec accommodates both `session_id` and `sessionId` keys with a fallback). All other behavior — HTTP shape, slug parsing, error handling — is identical. Per CLAUDE.md doctrine: "per-client divergence ONLY when the platform forces it".

## Risks / Trade-offs

- **[Risk] Cross-token id collisions are theoretically possible (different users picking the same id).** Mitigation: the service-layer `SELECT before INSERT` rejects with `id_collision` deterministically. Realistic probability with UUID/ULID clients is ~10^-36; non-issue.

- **[Risk] The fallback "most-recently-active row" resolution attaches memories to the wrong session if the user has two Claude windows open against the same project.** Mitigation: realistic scenario is rare (most users have one window per project). When it happens, both windows still write to the same project; only the per-session timeline view in the dashboard is slightly wrong. The `SessionRouter` path (when the agent explicitly calls `memory.session_start`) remains authoritative and supersedes the fallback. Tests cover the "two active sessions" scenario; doc note in `sessions/spec.md`.

- **[Risk] HTTP endpoint exposure widens the attack surface.** Mitigation: identical auth to `/mcp` (same bearer token, same `authenticate()` helper). The endpoints are path-scoped, so a token-scope-vs-path-slug mismatch is rejected by the existing scope check before any DB write. No new credentials, no new rate limits needed (the existing per-token limiter at `src/server/rate-limit.ts` applies in the Hono pipeline once we register the route).

- **[Risk] Hook scripts may be invoked outside of a Claude/Codex environment (e.g. someone manually `bash plugin/scripts/session-start.sh`) without stdin JSON.** Mitigation: scripts already trap errors and `exit 0`; the stdin parser tolerates empty input and skips the POST.

- **[Risk] PreCompact's payload size can be large (whole transcript).** Mitigation: server clamps `summary` at 20k chars (existing `sessionSummarySchema`). Larger transcripts truncate at the script level with a one-line stderr diagnostic. The summary is meant as a recovery snapshot, not a full transcript archive.

- **[Trade-off] Two parallel session-creation paths now exist: HTTP `/api/<slug>/sessions` (hook-driven) and MCP `memory.session_start` (agent-driven).** The MCP tool stays for backwards compatibility and for clients that don't run the plugin. Doc note in `mcp-api/spec.md` will clarify that HTTP is the preferred path. A future change MAY deprecate the MCP tool if all maintained clients adopt the plugin.

## Migration Plan

1. Land the service change (`AgentSessionsService.start()` with optional `id`) — backwards-compatible (mints ULID when no id provided), so it's safe to ship before any caller changes.
2. Land the HTTP router (`src/server/api-router.ts`) + integration tests. No clients hit it yet; tests verify behavior.
3. Land the plugin hook changes (`session-start.sh` engordado, `pre-compact.sh` new, `session-stop.sh` new, `hooks.json` and `hooks.codex.json` updated, `post-compact.sh` deleted). Smoke-test against a real Claude Code install (matrix in tasks.md).

Rollback: if the hook changes cause issues in field, revert the plugin files in isolation. The HTTP API can remain dormant (no clients call it) and the service-level change is forward-compatible (no callers pass `id` yet by default). No schema migration needed and none to revert.
