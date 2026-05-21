## Context

The shared SQL fragment `sessionHasContentSql(alias)` (introduced in `2026-05-21-filter-empty-sessions-from-context`, `apps/server/src/services/agent-sessions.ts:26-34`) was conceived as a single source of truth for "this session has something worth surfacing." Two call sites consume it:

- Positively, by `AgentSessionsService.recentForContext` to filter the agent-facing `memory.context.recentSessions` list.
- Negatively, by `AgentSessionsService.countPurgeableEmpty` and `AgentSessionsService.purgeEmpty` to identify sessions an operator may physically delete.

Empirical observation (2026-05-21 live stack) shows the unification was premature. The same predicate cannot serve both call sites well because they ask different questions:

- The **purge predicate** must protect any session whose physical deletion would dangle foreign keys. A session with at least one `memory` row referencing it MUST NOT be purged, even if uncurated — the memory survives, but its `session_id` becomes a dangling reference. The 5-clause predicate is exactly right for this.
- The **surfacing predicate** must select sessions that contribute usable signal to the LLM's bootstrap snapshot. A session whose `summary` is a raw transcript dump (`final:false`) contributes noise; a session with anchored memories but `summary: null` contributes a stub row. Neither is useful at the session granularity, even though the memories themselves are useful at the memory granularity (and appear in `recentMemories[]`).

Independently, the HTTP fallback path leaves a trust gap. `POST /api/<slug>/sessions/:id/summary` accepts a body `{ summary, title?, final?: boolean }` and forwards `final` directly to `writeSummary`. All four shipped plugins pass `final:false`, but the structural authority for "this is curated" rests on plugin discipline rather than on server-enforced rules. A buggy or malicious fifth client could mark a transcript dump as `final:true` and pollute curated signal.

## Goals / Non-Goals

**Goals:**

- `memory.context.recentSessions` returns exclusively curated sessions: every row has `summary_final = 1` or `title_final = 1`, set via the MCP tool `memory.session_summary` through a server-hardcoded code path. Zero exceptions.
- Sessions with anchored content but no curated summary still contribute to the LLM via `recentMemories[]` — the agent loses the "session header" but keeps the granular work, plus the `session_id` to call `memory.timeline` if it wants to inspect the thread.
- Purge predicate stays exactly as today. Sessions with anchored memories/prompts/confirmations remain non-purgeable; referential integrity stays intact.
- The structural authority for `summary_final = 1` collapses to a single code path: the MCP tool's hardcoded `final:true` call. No HTTP body can influence it.

**Non-Goals:**

- Filtering empty / transcript-only sessions out of operator-facing surfaces. `/dashboard/sessions`, `/dashboard/sessions/:id`, and `memory.stats.sessionsByStatus` MUST continue to show every row.
- Changing plugin write behaviour. All four plugins continue to POST per-turn transcripts with `final:false`; the hardening just makes the field's value irrelevant on the HTTP path.
- Adding heuristics, regex, or content inspection at any layer. The decision rests on a boolean column populated structurally by the write path.
- Server-side derived summaries (computing a synthetic summary from memory titles). Out of scope; `recentMemories` already exposes the granular signal.
- Forcing the agent to call `memory.session_summary`. Cannot be enforced at the protocol level; the existing plugin nudges (in `session-stop.sh`, `post-compact.sh`, Hermes `__init__.py`, opencode `plugin.ts`) are the right surface.

## Decisions

### Decision 1 — Two predicates, not one

**Choice:** Introduce `sessionIsContextWorthySql(alias)` as a new SQL fragment alongside the existing `sessionHasContentSql(alias)`. The new predicate is `(${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1) OR ${alias}.title_final = 1`. It is consumed by `recentForContext` only. `sessionHasContentSql` keeps its 5 clauses and continues to drive `countPurgeableEmpty` / `purgeEmpty`.

**Why:**

- Surfacing and purge ask different questions; conflating them into one predicate forces a compromise on both. Separating gives each call site a tight, named contract.
- Strict-subset relationship: every context-worthy session is also content-bearing (the converse is not true). This makes the two predicates feel like a refinement, not a duplication. A code search reveals the relationship at a glance.
- No new state, no new column, no new write path. Both predicates read the same row fields. The only thing changing is the WHERE clauses in two existing query builders.

**Alternatives considered:**

- **A. Single tightened predicate.** Replace the 5-clause predicate with the 2-clause `sessionIsContextWorthy` everywhere. Rejected: sessions with anchored memories but no curated summary would become purge-eligible. Physical purge would dangle `memory.session_id` references. Unacceptable.

- **B. Single predicate, return `summary: null` to the LLM when `summary_final = 0`.** Considered. Cleaner than today, but leaves stub rows (`{ id, summary: null, … }`) in `recentSessions` that occupy slots without informing the LLM. The user's intuition that this is still noise is correct.

- **C. Three predicates** (content-bearing, context-worthy, purge-eligible). Rejected: no third question to ask. Two predicates is the natural shape of the problem.

### Decision 2 — Hardcode `final: false` in the HTTP path

**Choice:** Remove the `final` field from the request-body schemas for `POST /api/<slug>/sessions/:id/summary` and `POST /api/<slug>/sessions/:id/end`. The corresponding handlers in `apps/server/src/server/api-router.ts` SHALL pass `final: false` to `writeSummary` / `end` unconditionally. The MCP tool `memory.session_summary` keeps its hardcoded `final: true` in `apps/server/src/mcp/sessions-tools.ts:410`.

**Why:**

- After the predicate split, the entire trust chain for "is this session worth surfacing?" reduces to "is `summary_final` truthful?" — and that flag is now exclusively settable via one server-hardcoded line of code.
- The HTTP path's `final` field was always a client-controlled trust hole. Removing it costs nothing (no client uses `final:true` today) and converts a convention into an invariant.
- Reduces the API surface area. The body schemas become smaller. Schema-level documentation no longer has to explain "you can pass `final` but please don't unless you're the model."

**Alternatives considered:**

- **A. Keep the field but coerce to `false` server-side.** Rejected: leaves a confusing field in the public schema. A future contributor will see it and wonder "why is this here if it's ignored?" Cleaner to remove.
- **B. Accept `final:true` over HTTP and trust plugins.** Rejected: explicit user concern about not trusting hooks. Convention-based trust is exactly what the hardening is meant to replace.
- **C. Add a separate "admin-only" header gate for `final:true`.** Rejected: introduces a third path (admin HTTP), invents tooling, no caller in tree needs this.

### Decision 3 — Preserve operator visibility surfaces unchanged

**Choice:** No template change, no `list()` change, no `countByStatus()` change. `/dashboard/sessions`, `/dashboard/sessions/:id`, `/dashboard/maintenance`, and `memory.stats.sessionsByStatus` continue to surface every session row regardless of curation status.

**Why:**

- The user explicitly said the operator must see everything; the LLM filter is orthogonal.
- These surfaces consume `AgentSessionsService.list()` or `countByStatus()`, neither of which uses either predicate. The orthogonality is already structural — no risk of accidental coupling.
- Operators need uncurated rows visible to decide on `purgeEmpty`. The maintenance page's "Purge empty sessions" card displays the count and requires confirmation.

**Alternatives considered:**

- **A. Also hide uncurated sessions from `/dashboard/sessions` by default with a toggle.** Rejected: operator workflow argument. The operator's job is precisely to inspect what the agent did or did not curate; hiding it would be counterproductive.

## Risks / Trade-offs

- **[Trade-off]** Sessions where the agent saved memories but forgot `memory.session_summary` no longer appear as `recentSessions` rows. → **Accepted because:** their memories continue to appear in `recentMemories[]` with `session_id` attached. The agent can call `memory.timeline({sessionId})` to reconstruct the thread. The session "header" was contributing low value anyway — a row with no curated summary forces the agent to read raw transcript or infer context, which is precisely what `memory.session_summary` was designed to avoid.

- **[Risk]** A future contributor adds a fifth client (a Cursor plugin, say) and writes `final:true` over HTTP expecting it to take effect. → **Mitigation:** the server silently ignores the field; spec deltas in `http-api/spec.md` codify the contract; the schema-level rejection makes the misconfiguration loud at zod-validation time if `strict: true` is added later.

- **[Risk]** Operators see a larger "Purge empty sessions" count immediately after this change lands. → **Mitigation:** the count growth corresponds to legitimately stale transcript-only sessions. The maintenance page already displays the count and gates the action behind a confirmation modal. No automatic purge — the operator opts in.

- **[Trade-off]** The "single source of truth for session-has-content" invariant from PR #71 is refined. The drift-detection scenario in the existing spec (`Drift between purge predicate and context predicate is impossible`) needs an update because the two predicates now legitimately differ. → **Accepted because:** the difference is structurally bounded — `sessionIsContextWorthy(s) → sessionHasContent(s)` always. The drift scenario rewords to assert this strict-subset relationship and to enforce that the EXISTS-bearing 5-clause predicate appears in exactly one place (its helper).

- **[Trade-off]** Two existing tests in `api-router.test.ts` that POST `{final: true}` to set up the locked-precedence state need to migrate to direct DB UPDATE. → **Accepted because:** the service-level precedence logic is already tested at `agent-sessions.test.ts`; the HTTP-level tests after the change should test the HTTP contract (no `final` accepted), not the underlying precedence rule.

## Migration Plan

No data migration. The change is read-side filter + write-side schema narrowing:

1. Add `sessionIsContextWorthySql` helper.
2. Repoint `recentForContext` to consume it.
3. Update JSDoc on `sessionHasContentSql` to clarify its purge-only scope.
4. Hard-code `final: false` in HTTP `/summary` and `/end` handlers.
5. Drop `final` from the corresponding zod body schemas.
6. Update tests (unit + integration + http).
7. Apply spec deltas across `sessions`, `mcp-api`, `http-api`.
8. Archive the change.

Rollback: revert the two SQL helper changes, restore `final` to the body schemas. The `summary_final` column data on disk is unaffected by either direction.

## Use-case flow diagrams

The five canonical flows under the post-change contract. Each shows the trigger, the server decision, the resulting DB state, and what the LLM sees in `memory.context.recentSessions`.

### Tipo A — Noise session (`/clear`, opencode "Hola!", transcript-only)

```
Agent:  memory.session_start
        ↓ (no memory.save, no memory.session_summary)
Plugin Stop hook: POST /summary { summary: "user: <transcript>", final:false (forced) }
        ↓ server writes summary_final=0 (cannot be lifted via HTTP)
Agent:  memory.session_end
        ↓
SERVER end():
   ┌─ summary_final = 0 → proceed to auto-curate check
   ├─ EXISTS memory? NO
   ├─ EXISTS prompts? NO
   ├─ EXISTS confirmations? NO
   └─ total = 0 → SKIP auto-curate
        ↓
UPDATE sessions SET status='ended', ended_at=now WHERE id=?
        ↓
DB state: { status: ended, summary: '<transcript>', summary_final: 0 }

memory.context.recentSessions  ✗ EXCLUIDA  (sessionIsContextWorthy = false)
/dashboard/sessions            ✓ visible al operador
purgeEmpty (>1h grace)         ✓ elegible para limpieza
```

### Tipo B — Work without curation (auto-curate fires)

```
Agent:  memory.session_start
Agent:  memory.save({ content: 'Fixed null check…' })   ← anchored to session
        ↓ (no memory.session_summary)
Plugin Stop hook: POST /summary (irrelevant, summary_final stays 0)
Agent:  memory.session_end
        ↓
SERVER end():
   ┌─ summary_final = 0 → proceed to auto-curate
   ├─ EXISTS memory? YES (1 row)
   ├─ count memories: 1
   ├─ SELECT last memory.content → 'Fixed null check…'
   └─ derived = composeDerivedSummary({memories:1,…}, 'Fixed null check…')
                = "[auto] 1 memorias — última: 'Fixed null check…'"
        ↓
UPDATE sessions SET
   status     = 'ended',
   ended_at   = now,
   summary    = '[auto] 1 memorias — última: 'Fixed null check…'',
   summary_final = 1
   WHERE id=? AND status='active'
        ↓
DB state: { status: ended, summary: '[auto] 1 memorias…', summary_final: 1 }

memory.context.recentSessions  ✓ INCLUIDA con [auto] prefix
recentMemories                 ✓ memoria anclada también surface
purgeEmpty                     ✗ NO purgable (EXISTS memory protege FK)
```

### Tipo C — Curated session (agent calls memory.session_summary)

```
Agent:  memory.session_start
Agent:  memory.save({ content: '...' })
Agent:  memory.session_summary({ title: 'Refactor X', summary: 'Goal: …' })
        ↓
SERVER memory.session_summary handler (sessions-tools.ts:410):
   writeSummary({ summary, title, final: true })   ← HARDCODED final:true
        ↓
UPDATE sessions SET summary='Goal: …', title='Refactor X',
                    summary_final=1, title_final=1
        ↓
Agent:  memory.session_end
        ↓
SERVER end():
   ┌─ summary_final = 1 → SKIP auto-curate (agent already curated)
   └─ Just transition status + ended_at
        ↓
UPDATE sessions SET status='ended', ended_at=now
        ↓
DB state: { status: ended, summary: 'Goal: …', summary_final: 1 }

memory.context.recentSessions  ✓ INCLUIDA con texto del agente
/dashboard/sessions            ✓ visible al operador
purgeEmpty                     ✗ NO purgable
```

### Override — Agent overrides auto-curated session post-end

```
Setup: Tipo B already happened → session ended with [auto] summary.

Agent (next turn or any time later):
        memory.session_summary({ summary: 'Goal: real curate', title: 'X' })
        ↓
SERVER handler: writeSummary({ summary, title, final: true })
        ↓
SERVER writeSummary():
   ┌─ existing.status = 'ended' (terminal) → would normally reject
   ├─ BUT input.final === true → ALLOW (relaxed condition 2)
   └─ Apply precedence: summary_final stays 1, overwrite summary & title
        ↓
UPDATE sessions SET
   summary       = 'Goal: real curate',
   title         = 'X',
   summary_final = 1,
   title_final   = 1
   WHERE id=?   ← no status='active' gate, since terminal override path
        ↓
DB state: { status: ended (unchanged), summary: 'Goal: real curate',
            summary_final: 1, title_final: 1 }

memory.context.recentSessions  ✓ INCLUIDA con texto del agente (override gana)
```

### HTTP hardening — Plugin tries `final:true` over HTTP

```
Plugin Stop hook (buggy or malicious):
   POST /api/<slug>/sessions/:id/summary
   Body: { summary: 'fake curated', title: 'X', final: true }
        ↓
SERVER api-router.ts:
   ┌─ zod schema: { summary, title } — `final` field is DROPPED silently
   ├─ parsed.data.final = undefined
   └─ Call writeSummary({ summary, title, final: false })  ← HARDCODED false
        ↓
SERVER writeSummary():
   ┌─ existing.status = 'active' → condition 1 satisfied, accept
   ├─ incomingFinal = false
   ├─ applyPrecedence:
   │    - if existing.summary_final = 1: SKIP write (curated wins)
   │    - if existing.summary_final = 0: WRITE summary, leave flag = 0
   └─ summary_final NEVER lifted to 1 via this path
        ↓
UPDATE sessions SET summary='fake curated', title='X' (summary_final unchanged)
        ↓
DB state: { summary_final: 0 OR 1 (whatever it was), NOT lifted by HTTP }

→ The `final` field is STRUCTURALLY INACCESSIBLE from HTTP. Only
  memory.session_summary (MCP) can lift the flag.
```

### Decision matrix

```
┌──────────────────────────────────┬─────────────┬─────────────┬───────────────┐
│ Session shape                    │ recentSess  │ Operador    │ Purgeable     │
│                                  │ (LLM)       │ /dashboard  │ (1h grace)    │
├──────────────────────────────────┼─────────────┼─────────────┼───────────────┤
│ Tipo A: no anchored, no curate   │     ✗       │     ✓       │      ✓        │
│ Tipo B: anchored, no curate      │  ✓ [auto]   │     ✓       │  ✗ (EXISTS)   │
│ Tipo C: curate explícito         │ ✓ curated   │     ✓       │  ✗ (EXISTS o  │
│                                  │             │             │  summary_fin) │
│ Override: ended + new curate     │ ✓ override  │     ✓       │  ✗ (igual C)  │
│ Vacía: start + end sin nada      │     ✗       │     ✓       │      ✓        │
└──────────────────────────────────┴─────────────┴─────────────┴───────────────┘
```

## Open Questions

None. The verification pass confirmed:

- The MCP tool `memory.session_summary` is the only path that writes `final:true` server-side (`apps/server/src/mcp/sessions-tools.ts:410`).
- All four plugins write `final:false` over HTTP (verified via grep across `apps/plugin/scripts/`, `apps/plugin/.hermes-plugin/__init__.py`, `apps/plugin/.opencode-plugin/plugin.ts`).
- All existing service-level `recentForContext content filter` tests use `sessions.summarize()` which writes `final:true`, so they continue to pass under the new surfacing predicate — except for the `includes a session referenced by at least one memory row` test, which legitimately flips to "does NOT include" (the memory is now expected in `recentMemories[]`, not as a session header).
- HTTP-level api-router tests that POST `{final:true}` are documented above as needing migration to direct DB UPDATE setup.
