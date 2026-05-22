## Context

`sessions.summary` is the **only** column the LLM reads back when starting a new turn — `memory.context.recentSessions` emits the summary verbatim, and the dashboard renders it as the row's primary text. Today every write path is gated by a `z.string().min(1).max(20_000)` cap at the zod boundary, the service layer only checks non-empty, and the SQLite column is unconstrained `TEXT`. With `recentSessions` defaulting to 5 rows, a single context lookup can pull back ~100 000 characters of session prose — useless as priming context, and the operator already observes summaries that feel like "a giant blob" in the wild.

Auto-curate (`composeDerivedSummary`) produces ~120 chars (`[auto] N memorias — última: '<80-char snippet>'`) so server-derived rows are not the problem; the long writers are (a) agents who follow the Goal·Discoveries·Acc·Next·Files protocol verbosely, (b) the bash transcript fallback (`session-end.sh`) and the opencode per-turn flush, both of which dump raw transcript text up to the wire cap.

Two pieces of prior art tightened this:

- **engram** (`mem_session_summary`) prompts for a "3-5 sentence narrative" (~300-500 chars) with a 100-char title cap — no DB enforcement, but the prompt sets the budget.
- **agentmemory** budgets context globally (~2 000 tokens for all retrieval), not per row.

We pick the engram-style "prompt sets the budget" approach and add a hard cap server-side as the backstop. The agent-facing surface (MCP) rejects on overflow so the agent re-writes; the hook-facing surface (HTTP) truncates server-side because the bash/Python/opencode writers cannot retry.

## Goals / Non-Goals

**Goals:**

- Cap `sessions.summary` at **2 000 chars** at every layer: DB CHECK, service-layer validation, MCP zod schema, HTTP handler truncate-before-call.
- Surface the cap to agents via prompts and tool descriptions so they don't routinely hit the rejection path.
- Truncate any pre-existing row that exceeds 2 000 chars during the migration; preserve append-only semantics (no row DELETE; `summary` is explicitly mutable).
- Keep one source of truth (`SUMMARY_MAX_CHARS`) — DB, service, MCP, and HTTP all derive their effective cap from it.

**Non-Goals:**

- Compressing or summarizing the truncated text: lossy substring + `'…[truncated]'` suffix only. Re-summarization would require an LLM hop and breaks the "no LLM in the consolidation path" rule.
- Touching `composeDerivedSummary`'s output (already ~120 chars, well under the new cap).
- Synchronizing the cross-language plugin constants (`hermes _SUMMARY_MAX_CHARS`, bash `_transcript.sh` tail size, opencode plugin truncate) to the new effective cap. Those stay as wire upper bounds — the server truncates anyway, so the only cost is sending a few extra KB on the wire from the hook writers. Optimizing the wire payload is out of scope for this change.
- Changing the structure of the summary body (Goal·Discoveries·Accomplished·Next Steps·Files). Only the length budget changes.
- Caching, search indexing, or any other downstream consumer of `sessions.summary` — none of them are sensitive to the cap.

## Decisions

### D1: SUMMARY_MAX_CHARS = 2000

**Choice:** Single constant exported from `apps/server/src/services/agent-sessions.ts`, value `2000`.

**Why 2000:**

- Empirical sample: the operator's most recent curated summaries are ~2 800–5 200 chars, and the operator describes those as "too big".
- 2 000 chars ≈ 500 tokens. With `recentSessions` default `limit:5`, that is ~2 500 tokens of session priming — comfortably below any reasonable model's "do not pollute the system prompt" budget.
- Forces the agent to synthesize: a tight Goal·Discoveries·Acc·Next·Files cribsheet fits in 2 000 chars, an exhaustive transcript dump does not.

**Alternatives considered:**

- **5 000 chars** — preserves the current writing style. Rejected: the operator explicitly wants a forcing function, not a generous cap.
- **800 chars** (matching `INSTRUCTIONS_MAX_LENGTH`) — too tight for the structured format. The protocol sentence in `instructions.ts` is 800 chars total for ALL teaching; the per-session summary is a different artifact.

### D2: Asymmetric overflow — MCP reject, HTTP truncate

**Choice:** MCP `memory.session_summary` rejects on overflow via zod (`invalid_input`). HTTP `/sessions/:id/summary` and `/sessions/:id/end` keep a `max(20_000)` zod wire-DoS guard and the handler truncates the body to `SUMMARY_MAX_CHARS - SUFFIX.length` + `'…[truncated]'` before calling the service.

**Why asymmetric:**

```
        MCP path                              HTTP path
  ┌────────────────────┐               ┌──────────────────────┐
  │ Client = AGENT     │               │ Client = HOOK SCRIPT │
  │ Can retry with     │               │ Bash/Python/opencode │
  │ a shorter summary  │               │ Already exited; cannot│
  │ on error           │               │ react to the error    │
  └────────┬───────────┘               └──────────┬───────────┘
           ▼                                      ▼
       REJECT                              TRUNCATE server-side
       → forces synthesis                  → no silent data loss for the agent
       → no silent data loss for the agent → preserves transcript fallback
```

Treating both paths the same breaks one of them: reject in HTTP means hooks lose the transcript fallback (`sessions.summary` stays NULL when the agent doesn't cooperate); truncate in MCP means the agent thinks its long-form summary was accepted when most of it was thrown away.

**Alternatives considered:**

- **Truncate everywhere.** Simpler, no error path. Rejected — silent data loss in the MCP path penalizes the cooperating agent.
- **Reject everywhere.** Cleanest contract. Rejected — kills the bash/opencode fallback (those clients have no retry mechanism). Also breaks the `plugin-session-protocol` convergence guarantee ("session converges on a non-null summary when the agent OR the transcript is reachable").

### D3: DB CHECK constraint added via SQLite table-rebuild

**Choice:** `CHECK (summary IS NULL OR length(summary) <= 2000)` added by table-rebuild dance in migration `0010_summary_length_check.sql`. Existing rows are pre-truncated in the same migration with `UPDATE sessions SET summary = substr(summary, 1, 1987) || '…[truncated]' WHERE length(summary) > 2000`.

**Why a DB CHECK:**

- Defense-in-depth: future bugs in the service layer or new write paths cannot silently store a 100 KB summary. The CHECK rejects the INSERT/UPDATE.
- Cheap: SQLite enforces `CHECK` on every write at no additional cost worth measuring for this volume.
- Documents the contract at the schema level — drizzle codegen and dashboard developers see the cap in one place.

**Append-only invariant compatibility:** `sessions.summary` is **mutable by design** (the `summary_final` precedence flag exists precisely because rewrites are expected — `writeSummary` updates it on every cooperating MCP call). The migration's `UPDATE` of existing rows is consistent with this invariant; the invariant prohibits row `DELETE` and `UPDATE` of immutable columns (`agent`, `token_id`, `project_id`, `started_at`), neither of which is touched.

**Alternatives considered:**

- **No DB constraint** — rely on service-layer validation. Rejected: every cap regression in the service or a new HTTP endpoint would silently break the invariant. The CHECK is the only enforcement that does not depend on application code being correct.
- **Trigger instead of CHECK** — overkill. CHECK is the idiomatic SQLite mechanism for length bounds.

### D4: Truncation suffix is `'…[truncated]'` (13 JS code units)

**Choice:** The truncation helper produces exactly `SUMMARY_MAX_CHARS` chars by slicing to `SUMMARY_MAX_CHARS - SUFFIX.length` and appending the suffix.

**Why this suffix:**

- Visible to the operator in the dashboard: makes server-side trimming obvious during debugging.
- Visible to the agent on the next `memory.context.recentSessions` lookup: the agent sees the suffix and knows there was more content it didn't write down — fitness signal to write tighter next time.

**SQLite vs JS length semantics:** `String.prototype.length` counts UTF-16 code units; SQLite `length()` counts code points. For non-BMP characters (e.g. emoji) these differ by 1 unit per character. The JS-side truncation produces exactly 2 000 JS units; the CHECK uses 2 000 code points, which is more lenient. Net: the CHECK never rejects a value that passed the JS cap, but a value composed entirely of code-point-1 characters (rare in the wild) could pass the CHECK while failing the JS cap. We accept this asymmetry; the JS layer is the source of truth and the CHECK is the backstop.

**Alternatives considered:**

- **Suffix `' ...'`** (3 chars) — saves 10 chars of budget for content. Rejected — too easy to confuse with a writer's own ellipsis. The `[truncated]` token is greppable.
- **No suffix** — silent truncation. Rejected for the same reason as D2: silent data loss is the worst kind.

### D5: Plugin-side wire bounds stay loose

**Choice:** Do not change `_SUMMARY_MAX_CHARS = 20_000` (Hermes) or the bash tail size (`_transcript.sh`) or the opencode plugin client-side truncation in this change. They remain wire upper bounds; the server truncates effectively at 2 000.

**Why keep them loose:**

- The change is one-way (server effective cap is now lower). Misaligned plugin upper bounds only mean a few extra KB on the wire, not data loss.
- Tightening plugin-side bounds would force a per-client release-please bump for a cosmetic optimization. The `claude-code-plugin` and `codex-plugin` cascade together via `bridge-bundlers`, but `hermes-plugin` and `opencode-plugin` release independently. Coordinating four releases for "send fewer bytes" is not worth it.
- The plugin-session-protocol spec scenarios that reference `19500 chars` are migrated to mention `SUMMARY_MAX_CHARS` abstractly, decoupling the spec from the literal wire upper bounds.

**Trade-off:** Plugin clients still send up to ~20 KB on a stale-transcript flush; the server discards ~18 KB of that. Operator-visible only on a network trace. Accepted.

## Risks / Trade-offs

- **[Risk] Existing rows lose information at migration.** → **Mitigation:** Truncation is the explicit goal; communicate via the `'…[truncated]'` suffix and document in `proposal.md` Impact. Operators can `pg_dump`-equivalent (`sqlite3 .backup`) before upgrade; the migration runs once and is logged.
- **[Risk] Cooperating agents on long sessions get rejected and retry-loop.** → **Mitigation:** The protocol sentence in `instructions.ts` and the tool description in `server.ts` both state the cap. The rejection error message includes the cap value so the agent has the budget on the very first retry. We test for the exact error code (`invalid_input`) and a message containing `2000` so client-side error handlers can extract it.
- **[Risk] HTTP truncation looks like data corruption to an operator who reads the row directly.** → **Mitigation:** Suffix `'…[truncated]'` is greppable; dashboard renders it inline; design.md (this file) is the authoritative explanation of why and when truncation happens.
- **[Trade-off] One column (`summary`) has DB-level CHECK; other text columns (e.g. `memory.content`, `prompts.content`) do not.** → **Accepted because** `sessions.summary` is the only column directly injected into the LLM's context priming; the others are content-addressable and not injected unsolicited. Cap parity across all text columns is a future change if symmetry becomes a concern.
- **[Trade-off] JS UTF-16 vs SQLite code-point length asymmetry (see D4).** → **Accepted because** the asymmetry only fires in one direction (CHECK is more lenient than JS), which is safer than the reverse.
- **[Risk] `seed-dev.ts` fixtures or test setups currently produce summaries > 2 000 chars.** → **Mitigation:** Task 4.4 audits seed and test fixtures; any offender is shortened at source. The test suite acts as the canary.

## Migration Plan

```
1. Pre-flight  (in PR)
   ├── audit seed-dev.ts for summaries > 2000 → shorten in source
   ├── audit test fixtures for summaries > 2000 → shorten in source
   └── update wire-upper bounds in plugin scripts where comments
       reference the old 20_000 number (purely cosmetic)

2. Code changes (in PR, atomic)
   ├── apps/server/src/services/agent-sessions.ts
   │   ├── export SUMMARY_MAX_CHARS = 2000
   │   ├── writeSummary / end / summarize: throw on len > MAX
   │   └── export truncateSummary(s) helper for the HTTP layer
   ├── apps/server/src/mcp/sessions-tools.ts
   │   └── sessionSummarySchema.summary = z.string().min(1).max(SUMMARY_MAX_CHARS)
   ├── apps/server/src/server/api-router.ts
   │   ├── keep sessionSummarySchema.summary.max(20_000) [DoS guard]
   │   └── handler: parsed.data.summary = truncateSummary(parsed.data.summary)
   ├── apps/server/src/mcp/instructions.ts
   │   └── update BASE protocol sentence (≤800 char ceiling)
   ├── apps/server/src/mcp/server.ts
   │   └── update memory.session_summary tool description
   └── apps/server/src/db/migrations/0010_summary_length_check.sql
       ├── PRAGMA foreign_keys=OFF; BEGIN;
       ├── UPDATE sessions SET summary=substr(summary,1,1987)||'…[truncated]'
       │     WHERE summary IS NOT NULL AND length(summary) > 2000;
       ├── CREATE TABLE sessions_new (… + CHECK on summary);
       ├── INSERT INTO sessions_new SELECT * FROM sessions;
       ├── DROP TABLE sessions; ALTER TABLE sessions_new RENAME TO sessions;
       ├── recreate all indexes/triggers that existed on sessions;
       └── COMMIT; PRAGMA foreign_keys=ON;

3. Prompts and protocol nudges (in PR, atomic)
   ├── apps/plugin/scripts/post-compact.sh
   ├── apps/plugin/.hermes-plugin/__init__.py (line 313 region)
   └── apps/plugin/commands/summary.md

4. Tests
   ├── service-layer: writeSummary/end/summarize reject > MAX (unit)
   ├── MCP: sessionSummarySchema rejects > MAX (zod test)
   ├── HTTP: handler truncates and stores ≤ MAX + suffix (api-router test)
   ├── Migration: round-trip — seed N rows including some > 2000 →
   │   migrate → assert all length ≤ 2000, suffix present on truncated,
   │   intact otherwise; assert direct INSERT of 2001-char row throws.
   ├── instructions.ts: length test still passes (800 ceiling)
   └── plugin-session-protocol scenarios update tests to use SUMMARY_MAX_CHARS

5. Validation gates
   ├── pnpm run typecheck && pnpm run lint
   ├── pnpm test (server + hermes)
   ├── openspec validate summary-length-cap --strict
   └── smoke against dev:docker:up: POST 5 000-char summary via MCP →
       invalid_input; via HTTP → 200 OK, DB row.length === 2000 +
       suffix; dashboard renders cleanly.

6. Land
   ├── branch feat/summary-length-cap, Conventional Commits
   ├── PR with the migration explicitly called out for operator review
   └── post-merge: /opsx:archive summary-length-cap
```

**Rollback:** the migration is one-way; rollback requires restoring the DB from backup (operator responsibility — see `docs/backup.md`). No supported "un-truncate" path exists.

## Open Questions

- Should `purgeEmpty` consider a `'…[truncated]'` summary as "empty"? **No** — the row has writers (anchored content) by construction (auto-curate only fires when EXISTS memory/prompts/confirmations). Truncation never produces a misclassification.
- Do we want to expose `SUMMARY_MAX_CHARS` to the agent via a `memory.doctor`-style discovery tool? **Not in this change.** The protocol sentence and tool description carry the number; if agents start systematically tripping on it, expose via `memory.doctor` in a follow-up.
- Should we add an invariant test forcing `apps/plugin/.hermes-plugin/__init__.py:_SUMMARY_MAX_CHARS` and the bash tail size to mirror the JS constant? **Not in this change.** Per D5 these are wire upper bounds, not the effective cap; mirroring them is cosmetic. Revisit if a future change tightens the wire path itself.
