## Why

`memory.context.recentSessions` is the LLM's bootstrap snapshot. Today it contaminates that snapshot in two distinct ways:

1. **Noise sessions** (`/clear`, `/rembric:context`, opencode `"Hola!"`, etc.) — sessions whose only content is a per-turn raw transcript dump written by plugin hooks (Claude Code Stop, Codex Stop, Hermes `pre_compress`, opencode `session.idle`) with `final:false`. The current shared predicate `sessionHasContentSql` treats any non-null `summary` as content and surfaces them.
2. **Stub sessions** — sessions where the agent saved memories but never called `memory.session_summary`. They surface via the predicate's `EXISTS(memory)` clause but expose a raw-transcript `summary` to the LLM, occupying a slot with low-value content.

Both issues share a root cause: the predicate `sessionHasContent` (introduced in `2026-05-21-filter-empty-sessions-from-context`) was overloaded to serve TWO concerns at once — purge eligibility (operator-facing) and context surfacing (LLM-facing). Those concerns have different thresholds: a session with anchored memories MUST be safe from physical purge (the memories' `session_id` references would dangle), but it does NOT necessarily belong in the LLM's bootstrap snapshot.

A third, independent trust gap reinforces the problem: the HTTP fallback path `POST /api/<slug>/sessions/:id/summary` accepts a client-controlled `final` flag in its body, meaning a misbehaving or buggy plugin could mark a transcript dump as `final:true` and pollute curated signal. Today all four shipped plugins correctly pass `false`, but the structural authority for "this is curated" should live in the server, not in client trust.

## What Changes

- **SPLIT the predicate.** Introduce a new SQL fragment `sessionIsContextWorthySql(alias)` in `apps/server/src/services/agent-sessions.ts`. Definition: `(${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1) OR ${alias}.title_final = 1`. The existing `sessionHasContentSql` is preserved verbatim and retains its five clauses; its scope narrows to "purge eligibility" via in-code documentation and spec wording.
- **REPOINT `recentForContext`** to consume `sessionIsContextWorthySql` instead of `sessionHasContentSql`. The change is in one call site (`recentForContext` in `agent-sessions.ts`).
- **PRESERVE purge behaviour.** `countPurgeableEmpty` and `purgeEmpty` continue to consume `sessionHasContentSql` (negated). Sessions with anchored memories/prompts/confirmations stay non-purgeable, protecting referential integrity.
- **HARDEN the HTTP path.** Remove the `final` field from the `sessionSummarySchema` and `sessionEndSchema` zod schemas in `apps/server/src/mcp/sessions-tools.ts` (or wherever they are defined for the HTTP handlers). The HTTP handlers `POST /api/<slug>/sessions/:id/summary` and `POST /api/<slug>/sessions/:id/end` in `apps/server/src/server/api-router.ts` SHALL hard-code `final: false` when calling `writeSummary` / `end`. The MCP tool `memory.session_summary` continues to hard-code `final: true` in its handler — that path stays the SOLE writer that lifts the `_final` flags.
- **EXTEND test coverage.** Update unit tests to lock in the new predicate behaviour: a session referenced only by anchored memory rows is NO LONGER surfaced via `recentForContext` (its memories still appear in `recentMemories[]`); a session with `summary_final = 0` is NO LONGER surfaced regardless of other content; only curated sessions (`summary_final = 1` or `title_final = 1`) surface. Update HTTP-path tests to assert that body `final:true` is ignored.

Not in scope:

- No plugin changes. All four shipped plugins already pass `final:false` over HTTP — the hardening just makes lying impossible structurally, it does not change the contract they implement.
- No migration, no schema change, no trigger, no backfill. The `summary_final` and `title_final` columns already encode the distinction with correct values populated by the existing write path.
- No new MCP tool, no removed MCP tool, no MCP argument changes.
- No dashboard changes. `/dashboard/sessions` continues to surface every row via `list()`; operators retain full visibility.
- No change to `memory.stats.sessionsByStatus` — counters keep including every row.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sessions`: REFINE `sessionHasContent` to clarify that it is the **purge-eligibility predicate** (single source-of-truth for "this session is safe to physically delete"). ADD a new requirement `sessionIsContextWorthy` defining the **surfacing predicate** as `(summary IS NOT NULL AND summary_final = 1) OR title_final = 1`. REFINE `recentForContext MUST exclude empty sessions by default` so it consumes the new surfacing predicate. The two predicates SHALL coexist: surfacing is a strict subset of content (curated content is content, but content is not necessarily curated).
- `mcp-api`: REFINE the `memory.context.recentSessions` scenario to specify that returned sessions SHALL satisfy `sessionIsContextWorthy`. Add a normative scenario: sessions with anchored memories but no curated summary SHALL NOT surface as `recentSessions` rows — their memories continue to appear in `recentMemories[]`.
- `http-api`: REFINE `POST /api/<slug>/sessions/:id/summary` and `POST /api/<slug>/sessions/:id/end` — the request body SHALL NOT accept a `final` field. The server SHALL treat all HTTP-path writes as `final:false`. Updating from `final:false` to `final:true` SHALL only be possible via the MCP tool `memory.session_summary`.

## Impact

**Code**

- Modified: `apps/server/src/services/agent-sessions.ts` — add `sessionIsContextWorthySql`, repoint `recentForContext` to consume it; update JSDoc on `sessionHasContentSql` to clarify its purge-only scope.
- Modified: `apps/server/src/server/api-router.ts` — hard-code `final: false` in the two HTTP summary/end handlers.
- Modified: HTTP body schema definitions (drop `final` from `sessionSummarySchema` and `sessionEndSchema`).
- Modified: `apps/server/src/services/agent-sessions.test.ts` — update the `recentForContext content filter` describe block to reflect the new predicate (one existing test flips its assertion; three new tests added).
- Modified: `apps/server/src/server/api-router.test.ts` — update existing precedence tests that POSTed `final:true` via HTTP. Locked-state setup migrates to direct DB UPDATE; add a new test asserting that HTTP body `final:true` is silently ignored and `summary_final` stays `0`.
- Modified: `apps/server/src/test/mcp-integration.test.ts` — add a scenario: session with anchored memory but no `memory.session_summary` call SHALL NOT appear in `recentSessions`, while its memory SHALL appear in `recentMemories[]`.

**Spec deltas**

- `openspec/specs/sessions/spec.md` — refine `sessionHasContent` scope; add `sessionIsContextWorthy`; refine `recentForContext`.
- `openspec/specs/mcp-api/spec.md` — refresh `memory.context.recentSessions` scenario.
- `openspec/specs/http-api/spec.md` — drop `final` from request body of `/summary` and `/end`; document server-forced `final:false`.

**Surfaces unchanged**

- MCP tool schemas: untouched.
- Dashboard templates: untouched.
- `memory.stats`, `memory.timeline`: untouched.
- Plugin manifests and scripts: untouched (all four clients already pass `final:false` — hardening just makes deviation impossible).
- DB schema and migrations: untouched.

**Behavioral consequences**

- LLM context becomes strictly curated: every row in `recentSessions` has `summary_final = 1` or `title_final = 1`, written by the MCP tool `memory.session_summary` through a server-hardcoded path. Zero `summary: null` rows, zero transcript-dump summaries, zero `/clear`-style noise.
- Sessions where the agent forgot `memory.session_summary` but anchored memories still contribute via `recentMemories[]` (with `session_id` available for `memory.timeline` follow-up).
- Operator visibility preserved: `/dashboard/sessions`, `/dashboard/sessions/:id`, `/dashboard/maintenance`, and `memory.stats.sessionsByStatus` continue to show every row.
- More sessions become purge-eligible (those whose only content was a transcript dump). `purgeEmpty` semantics unchanged otherwise; existing 1h `ended_at` grace prevents racing with late writes.
- Trust model becomes structural: the `_final` flags can only be lifted by the MCP tool, never by HTTP. No future plugin (in any language) can accidentally or maliciously corrupt curated signal.

**Invariants touched**

- Append-only memory: untouched.
- Scope enforced at the service layer: untouched.
- `topic_key` convergence: untouched.
- Fresh-context judgment: untouched.
- "Single source of truth for session-has-content": REFINED. The predicate splits into two clearly-named helpers, each with one consumer (or one type of consumer). Drift between them is structurally constrained: surfacing is a strict subset of content-bearing.

**Risk**

- A future contributor adds a fifth client and writes `final:true` over HTTP expecting it to take effect. → **Mitigation:** the server silently ignores; spec deltas codify the contract; the only documented path to curate is `memory.session_summary` (MCP).
- Operators may be surprised that `Purge empty sessions` offers a larger count immediately after the change lands. → **Mitigation:** the count growth corresponds to legitimately stale transcript-only sessions; the maintenance UI already shows the count before purge and includes a confirmation modal.
