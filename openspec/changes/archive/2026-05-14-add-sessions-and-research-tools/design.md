## Context

The four existing memory tools form a complete CRUD-like surface, but research is not CRUD. Research is "bootstrap context → recall → drill down → capture → hand off". Each of those movements maps to a specific MCP tool in Engram (`mem_context`, `mem_search`, `mem_timeline`, `mem_capture_passive`, `mem_session_summary`). Rembric currently has only step two (`memory.search`).

The minimal addition that closes the gap is **sessions as first-class state** plus six tools that read or write through that state. Without sessions, `memory.context` cannot answer "what happened in the last 5 sessions", `memory.timeline` cannot bound its window, and `memory.session_summary` has nothing to attach to. Once sessions exist, the rest of the tools are thin wrappers.

### Why sessions are append-only

The same reasoning that drives the append-only `memory` table applies to sessions. A session row records "an agent of identity X connected at time Y under token Z and ended at time W with this summary". That is durable history, not mutable state. Lifecycle becomes a status transition (`active` → `ended` | `abandoned`), never a delete. This makes every research path reproducible: anyone replaying the journal sees the same context at the same point in time.

### Why `session_id` on `memory` is nullable

Backwards compatibility. Existing agents that connect today, save memories without ever calling `memory.session_start`, must continue to work unchanged. A null `session_id` means "this memory was not anchored to a session at save time". That is a valid state — the memory is still searchable and confirmable.

When an agent does call `memory.session_start`, the returned `sessionId` is echoed back via a response header (or, for clients that ignore it, available via `memory.context`). Subsequent `memory.save` calls in the same MCP transport session **and** the same project automatically attach the active `session_id` server-side. The agent does not have to pass it on every call.

```
            ┌────────────────────────┐
agent ──▶   │ memory.session_start   │  → { sessionId: "01HX...", ... }
            └────────────────────────┘
                       │
                       │ server records active session against
                       │ (token_id, project_id, mcp-session-id)
                       ▼
            ┌────────────────────────┐
agent ──▶   │ memory.save            │  ← server reads active session,
            │   (no session_id arg)  │     stamps memory.session_id
            └────────────────────────┘
                       │
                       ▼
            ┌────────────────────────┐
agent ──▶   │ memory.session_summary │  ← writes summary text + status='ended'
            │   { summary }          │
            └────────────────────────┘
```

## Goals / Non-Goals

### Goals

- An agent connecting cold can answer "what should I know?" with a single tool call (`memory.context`).
- Given any observation, an agent can drill into its temporal neighborhood within the same session.
- Hand-off between sessions is captured in a structured summary that the next session can read back.
- Tool descriptions teach the agent the protocol; the agent does not need an external prompt to know when to save.
- Zero changes to the request/response shapes of the four existing tools.

### Non-Goals

- Real-time multi-agent collaboration within the same session. One session = one agent.
- Server-driven session timeouts (idle GC). Sessions only end via explicit `memory.session_end` or `memory.session_summary` calls, or when a server restart marks the active session as `abandoned`.
- Branching session histories or cross-session merge. Sessions are linear append-only.
- Persisting raw conversation turns alongside the summary. We store the summary; full transcripts stay in the agent.

## Decisions

### Decision 1: How does the server know which session a `memory.save` belongs to?

**Approach.** When `memory.session_start` is called, the server records `(token_id, project_id, mcp_session_id) → active_rembric_session_id` in an in-memory map keyed by the MCP transport session id (`mcp-session-id` header in Streamable HTTP). Subsequent calls within the same MCP transport session that match `(token_id, project_id)` automatically pick up the active session id.

**Why not require `session_id` on every call?** Agents that already use the four existing tools should keep working without changes. Making it server-resolved means an agent that _upgrades_ to using `session_start` gets the benefit immediately, without rewriting all its `save` calls.

**Why not key on the bearer token alone?** Two agents (or two terminal windows) using the same token must not be conflated. The MCP transport session id is the natural per-process boundary.

**Why not persist the mapping in the DB?** It is request-routing state, not durable state. If the server restarts, in-flight sessions are marked `abandoned` and the next `memory.session_start` from any client creates a fresh one. This matches the existing MCP transport behavior (the StreamableHTTP transport already discards in-flight session ids on restart).

### Decision 2: Where does `memory.context` look?

The default response shape is:

```json
{
  "recentSessions": [
    /* up to 5, most recent first */
  ],
  "recentPrompts": [
    /* up to 10, most recent first */
  ],
  "recentMemories": [
    /* up to 20, last_seen_at descending, scope-filtered */
  ]
}
```

Recency is `last_seen_at` (matching what `memory.search` already touches). Scope is read from the request context — global vs. path-scoped — so the same call returns different content depending on the `/mcp/<slug>` mount.

Optional argument `limit` clamps each list (default 5/10/20, max 25/50/100). Optional argument `includeArchived` is **false** by default — research-time context never surfaces archived rows unless the agent opts in.

### Decision 3: How big is the timeline window?

`memory.timeline({memoryId, before?: 5, after?: 5})` returns the `before` memories immediately preceding and the `after` memories immediately following the target, scoped to the same `session_id`. If the target has a null `session_id` (saved before this change, or by an agent that never called `session_start`), the timeline falls back to "global chronological within scope" (a date-bounded window of ±2h around the target's `created_at`). The fallback is documented in the tool description so agents know what they will get.

Max `before + after` is 50. Beyond that, the agent should call `memory.search` with filters.

### Decision 4: `memory.capture_passive` parser contract

The tool accepts `{text, sessionId?}`. It scans for a section that matches `^## Key Learnings:\s*$` (case-sensitive header), then collects subsequent numbered or bulleted items until the next H2 or end-of-string. Each item becomes its own `memory.save` with `type='discovery'` and the active scope. Returns a list of created memory ids.

The parser is deliberately strict (no fuzzy matching) so agents can rely on the exact format. The Engram protocol uses the same convention, so an agent prompted for either tool emits the same output.

### Decision 5: What does `memory.doctor` actually check?

The tool returns a small JSON report:

- `db.open`: boolean (the SQLite handle is alive)
- `db.journalMode`: string (should be `wal`)
- `db.integrity`: result of `PRAGMA quick_check`
- `db.size`: bytes
- `llm.reachable`: boolean (last successful `LlmClient.ping` within the past hour)
- `embeddings.enabled`: boolean
- `embeddings.backlog`: number of memory rows without a `memory_vec` row
- `consolidation.lastRunAt`: timestamp or null
- `consolidation.lastRunOps`: counters
- `sessions.active`: number of `status='active'` sessions
- `warnings`: array of human-readable strings if any of the above is anomalous

The tool is read-only and cheap enough to call once per session start.

### Decision 6: What does the rewritten tool description look like?

For `memory.save`:

```
"Save a structured memory. Call this IMMEDIATELY after any of:
  - a bug fix
  - an architecture / design decision
  - a non-obvious discovery about the codebase
  - a configuration change
  - a pattern (naming, structure, convention)
  - a user preference or constraint
Required: type ∈ {user,feedback,project,reference}, content (free-form).
Optional: tags[].
This MCP connection is path-scoped (/mcp/<slug>) → save is locked to that
project; scope='global' is rejected with code 'scope_locked'. On an
unscoped connection (/mcp) → scope defaults to 'global'; saving project
memories requires opening a path-scoped connection."
```

The pattern is: "WHEN to call" → "REQUIRED args" → "SCOPING rule". The Engram descriptions follow the same shape. The current Rembric descriptions explain the rule first; this change inverts the priority so the agent reads the action trigger first.

### Decision 7: Why not a `memory.session_list` tool?

`memory.context` already returns `recentSessions`. A separate list tool would be redundant. If an operator wants the full list, the dashboard at `/dashboard/sessions` shows it. The MCP surface stays minimal.

### Decision 8: What goes in the MCP `initialize.instructions` block, and how is it scoped?

The MCP lifecycle spec (2025-11-25) defines `InitializeResult.instructions: string?` — supported clients inject this into the LLM's system prompt automatically. Engram's "Memory Protocol" lives there: WHEN to save, WHEN to search, SESSION CLOSE PROTOCOL, PASSIVE CAPTURE.

**Hard constraint: token budget.** Instructions ship to the LLM on every turn while the connection is alive. They MUST stay short. The target is **≤ 800 characters** (~200 tokens). Anything longer is rejected by the CI test described in the spec. The verbose protocol lives in `docs/agents.md` and in each tool's `description`; `instructions` is the trigger-list crib sheet, not the manual.

Two variants, one per scope. The `McpTransportManager` already constructs a fresh `McpServer` per transport session via a factory closing over `(token, project)` context — we compute the variant inside the factory:

```
─ /mcp/<slug> instructions (~410 chars) ──────────────────────────
Rembric memory for project '<slug>'.

Call memory.save right after: bug fix · decision · discovery ·
config change · pattern · user preference.
Call memory.search when the user references past work.
Call memory.session_summary before saying "done" (Goal,
Discoveries, Accomplished, Next Steps, Files).

scope='global' is rejected on this connection — open /mcp for
user-wide memory.

─ /mcp (unscoped) instructions (~390 chars) ─────────────────────
Rembric memory, user-wide (global) scope.

Call memory.save right after: bug fix · decision · discovery ·
config change · pattern · user preference.
Call memory.search when the user references past work.
Call memory.session_summary before saying "done" (Goal,
Discoveries, Accomplished, Next Steps, Files).

For project memories, set X-Rembric-Project or open /mcp/<slug>.
```

A `buildInstructions(ctx)` helper keeps the protocol text in one place; only the trailing scope note diverges. A unit test asserts `instructions.length <= 800` for both variants.

**Why ship instructions over the wire when the tool descriptions already teach the protocol?** Tool descriptions live alongside the tool call — the LLM sees them when invoking. Instructions live in the system prompt — the LLM sees them while _deciding_ whether to invoke. Both matter; instructions complement descriptions, they do not replace them.

**Why not a static string?** "You are scoped to project X" needs per-session knowledge. The factory pattern already exists.

**Clients that ignore `instructions`?** Miss out — no harm. The same agents still get the protocol via tool descriptions.

### Decision 9: Project identity is slug, not path

The `projects.path` column is renamed to `projects.slug`. Paths never appear on the tool API and never cross the MCP wire. The slug is the **logical** identity of a project — the same `rembric` slug points to the same project whether the user has the working copy at `~/work/rembric` on a laptop or `~/personal/repos/rembric` on a desktop. Cross-machine consistency falls out of this naturally; there is no collision risk because path is no longer in the equation.

**Slug grammar for new slugs (strict regex):**

```
slug ::= [a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?
```

Lowercase ASCII, alphanumeric and hyphen, 1–64 chars, no leading or trailing hyphen, no underscores or dots. Stricter than the URL slug regex (`[a-zA-Z0-9_.-]+`) used today.

**Legacy slugs continue to work.** Existing rows whose value doesn't pass the new regex (mixed case, dots, underscores from before this change) keep functioning for read and write. Only `project.use({slug, autocreate: true})` and `roots`-derived sluglet creation enforce the strict regex. The dashboard projects page flags legacy slugs with a non-blocking warning so operators can rename if they want.

**Two checkouts of the same repo on one machine share memory by design.** `~/work/foo` and `~/personal/foo` both derive `foo` and both go to the same project. If the operator wants them separated, that's a deliberate slug choice (`foo-work` / `foo-personal`), not an accident of filesystem layout.

### Decision 10: Project resolution is strict exact-match; typos surface as deterministic suggestions

Activation of a project (the moment `(token, mcp-session-id) → project_id` is fixed for the session) uses `SELECT * FROM projects WHERE slug = ?` and nothing else. No fuzzy match, no embedding-based similarity, no Levenshtein heuristic. Determinism is non-negotiable on the resolution path: the same slug input MUST produce the same project (or unambiguous `project_not_found`) across model versions, time, and machines.

When `project.use({slug})` returns `project_not_found`, the response payload includes `suggestedSlugs[]` computed from a Levenshtein distance ≤ 3 sweep over the existing slugs (deterministic, <1ms, no LLM). The maximum number of suggestions is 3, ordered by ascending distance. The agent surfaces these to the user; only an explicit second tool call with a corrected `slug` activates anything.

**Why not embeddings even for suggestions?** Cost, latency, and the absence of any quality benefit at this scale. Slug strings are short ASCII; trigram / edit-distance distinguishes them perfectly. The vector store (sqlite-vec) is reserved for memory **content** similarity, not for identifier resolution.

### Decision 11: The `X-Rembric-Project` header is removed

The header is dropped from the scope-resolution path. Project scope is sourced exclusively from, in order of precedence:

1. URL path: `/mcp/<slug>` — fixed for the duration of the MCP transport session.
2. Server-driven `roots/list` auto-detection — only activates pre-existing slugs.
3. Explicit `project.use({slug})` tool call — agent-driven, can `autocreate` with the opt-in flag.

**Why remove it?** With slug-as-identity and tools-based switching, the header is redundant _and_ footgun-shaped: an agent that ships a literal slug in headers cannot swap projects mid-session without reconnecting, and we have no way to ask "did you mean to switch?" because headers don't return values. The path-based and tool-based mechanisms cover every use case the header did, more cleanly.

**Migration impact.** Any agent configured to send `X-Rembric-Project` at v0.1 must reconfigure to either (a) hit `/mcp/<slug>` directly, or (b) call `project.use({slug})` after `initialize`. Pre-1.0 versioning permits the break; the release notes call it out as a required reconfiguration.

### Decision 12: Auto-detection via MCP `roots` is conservative

The `roots/list` request runs once, after `initialized`, in the session factory. Rules of behavior:

```
1. URL path /mcp/<slug> set → DO NOT call roots/list. Path wins.
2. URL path /mcp (no slug) → call roots/list.
   - Client doesn't support roots → fall through to global scope, suggestedSlugs=[].
   - roots/list returns [] (no workspace) → fall through to global, suggestedSlugs=[].
   - roots/list returns one or more roots:
     a. Derive slug from basename of the FIRST root (lowercase, [a-z0-9-]+).
     b. SELECT projects WHERE slug = <derived>.
        - exists, no active project in session → activate silently; source='roots'.
        - exists, but project already active for this session → DO NOT switch;
          add <derived> to suggestedSlugs in memory.project_current.
        - does not exist → DO NOT create; add <derived> to suggestedSlugs.
3. notifications/roots/list_changed fires later → re-derive, update suggestedSlugs,
   but NEVER auto-switch. The agent observes the change via project.current
   and acts on it explicitly.
```

If `roots/list` times out (no response within 2s) or errors, the discovery silently falls through to global. Discovery must never block the `initialize` flow nor fail an agent connection.

### Decision 13: Switching projects mid-session ends the active session first

If a session is active for project X and the agent calls `project.use({slug: 'Y', confirmSwitch: true})`, the server rejects with code `session_active_must_end` and returns `{ activeSessionId }` in the error payload. The agent must call `memory.session_summary` (or `memory.session_end`) first, then `project.use`, then `memory.session_start`. This makes the handoff explicit: no session ends without a summary, no implicit cross-project sessions.

A `project.use` call without `confirmSwitch` against a different active project returns `project_switch_requires_confirm`. A `project.use` call where the target slug matches the currently active project is idempotent and returns `{ switched: false }`.

### Decision 14: Project tools live under a new top-level `project.*` namespace

Tool names: `project.use`, `project.list`, `project.current`. Not `memory.project_use` — project management is a separate concern from memory CRUD, and grouping by top-level prefix makes that obvious in `tools/list` output. The MCP spec permits dotted names with arbitrary depth; we use exactly two segments (`namespace.verb`).

The four legacy tools keep their `memory.*` namespace. Future memory-domain tools (e.g. `memory.judge` in change #2) stay in `memory.*`. Session lifecycle is `memory.session_*` because sessions are owned by the memory layer (session IDs stamp memory rows). Project tools are `project.*` because projects are independent of any single memory.

## Risks / Trade-offs

- **Compatibility risk.** Adding `session_id` to `memory` and `confirmations` is a schema change. We mitigate by making the column nullable + adding it via a forward-only migration that does not backfill existing rows. Agents that never call `session_start` see no behavior change.
- **Behavior risk: agents over-call `memory.context`.** A new agent that calls `memory.context` on every prompt could amplify load. Default response sizes (5/10/20) are small enough to be cheap; we add a 60-call/minute rate limit guard at the tool level (separate from the existing per-token MCP limiter, which is opt-in).
- **Description drift.** Updating descriptions changes how every connected agent behaves, in ways we can only partly test. We mitigate by adding integration tests that assert the description contains the protocol-teaching phrases ("Call this IMMEDIATELY after"), so a careless edit fails CI.
- **`memory.timeline` fallback for null-session memories.** Pre-existing rows have no `session_id` and won't have one until the agent re-saves. Fallback to "±2h around `created_at`" is a heuristic, not perfect, but it gives the agent a useful answer instead of an error.

## Migration Plan

This is the first change after the v0 launch (`add-rembric`). Live data exists in the form of `~/.rembric/data.db` files on operators' machines.

- The `sessions` table is created by a forward-only migration (`0003_sessions.sql`).
- `memory.session_id` and `confirmations.session_id` are added as nullable columns in the same migration. No backfill — existing rows stay null.
- The migrations runner already handles forward-only application idempotently; no special path needed.
- Tool descriptions change at deploy time. Connected agents do not need to reconnect for the new descriptions to apply (they refresh on next `tools/list`).

## Open Questions

1. Should `memory.session_start` accept a free-text `description` (what the agent intends to work on) at start, in addition to `summary` at end? — Yes, low cost; document as "the seed goal of the session". Recorded as `summary` even though it's a seed, so the column stays single-purpose.
2. Should the dashboard show a session's full memory list inline, or just a count + link? — Just a count + link for now. The full list is one extra page click.
