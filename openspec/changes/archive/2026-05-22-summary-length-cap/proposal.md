## Why

`sessions.summary` is the only field that the LLM reads back via `memory.context.recentSessions` to prime the next session. Today every write path accepts up to **20 000 chars per row** (zod cap in MCP and HTTP; no DB constraint; no service-layer validation). With the default `limit:5` for context, that is a worst-case ~40 000 tokens of summary alone — useless as priming context, and the operator observes summaries in the wild that already feel like a "troncho gigante". We tighten the cap to **2 000 chars** at every layer and force convergence by making MCP a hard reject (the agent can retry tighter) and HTTP a server-side truncate (hook fallbacks cannot retry). Existing rows are truncated in-place by migration with a `…[truncated]` suffix.

## What Changes

- **BREAKING** Introduce `SUMMARY_MAX_CHARS = 2000` as the single source of truth (exported from `apps/server/src/services/agent-sessions.ts`).
- **BREAKING** Service-layer `writeSummary` / `end` / `summarize` reject `summary` > 2 000 chars with `DomainError('invalid_input', …)`. (Today only non-empty is validated; the upper bound is enforced only at the zod boundary.)
- **BREAKING** MCP `memory.session_summary` zod schema `summary: z.string().min(1).max(2_000)`. Returns `invalid_input` on overflow — the agent is expected to re-call with a shorter body.
- HTTP `POST /sessions/:id/summary` and `POST /sessions/:id/end` keep an upper safety bound at `z.string().min(1).max(20_000)` (DoS guard) but the handler truncates to `SUMMARY_MAX_CHARS` + `'…[truncated]'` suffix before calling the service. Hook scripts and opencode per-turn flushes never see a rejected write.
- **BREAKING** New migration `0010_summary_length_check.sql` adds `CHECK (summary IS NULL OR length(summary) <= 2000)` via SQLite table-rebuild, after truncating any pre-existing row with `length(summary) > 2000` to `substr(summary, 1, 1987) || '…[truncated]'`. Documented one-way: truncation is lossy and cannot be reversed.
- Update MCP `initialize.instructions` (≤800-char ceiling preserved) to mention the new cap in the session-close protocol sentence.
- Update tool description for `memory.session_summary` in `apps/server/src/mcp/server.ts` to state the cap and the rejection on overflow.
- Update plugin-side prompts that direct the agent to call `memory.session_summary`: `apps/plugin/scripts/post-compact.sh`, `apps/plugin/.hermes-plugin/__init__.py`, `apps/plugin/commands/summary.md`.
- Re-align bash transcript fallback `apps/plugin/scripts/_transcript.sh` tail comment + size (currently "≈ server caps at 20000 chars") and the Hermes-side per-write upper bound (`_SUMMARY_MAX_CHARS = 20_000`) — these stay wire-upper-bounds (server truncates anyway), but the comments and the spec scenario referencing `truncated to 19500 chars` move to the new number.
- `composeDerivedSummary` (auto-curate, output ~120 chars) is untouched.

## Capabilities

### New Capabilities

_None._ This change tightens existing requirements across already-defined capabilities.

### Modified Capabilities

- `sessions`: `writeSummary` / `end` / `summarize` add an upper-length precondition; new validation requirement for `SUMMARY_MAX_CHARS`.
- `mcp-api`: `memory.session_summary` rejects `summary` > 2 000 chars with `invalid_input`. `initialize.instructions` references the new cap in the session-close protocol sentence (≤800-char total ceiling preserved).
- `http-api`: `POST /sessions/:id/summary` and `POST /sessions/:id/end` truncate `summary` to 2 000 chars + `'…[truncated]'` server-side. Their zod schemas keep `max(20_000)` as a wire DoS guard, distinct from the effective service-layer cap.
- `persistence`: `sessions.summary` SHALL have a SQLite `CHECK` constraint enforcing `length(summary) <= 2000`. The 0010 migration SHALL truncate any pre-existing row whose `summary` exceeds the cap before adding the constraint.
- `plugin-session-protocol`: bash / Python / opencode fallback scenarios update their truncation budget references (was `19500 chars`); the agent-facing post-compact and Hermes injection prompts state the new cap.

## Impact

Affected code:

- `apps/server/src/services/agent-sessions.ts` (new constant + service-layer validation)
- `apps/server/src/mcp/sessions-tools.ts` (`sessionSummarySchema.summary.max`)
- `apps/server/src/mcp/server.ts` (`memory.session_summary` tool description)
- `apps/server/src/mcp/instructions.ts` (protocol sentence; the 800-char ceiling holds — verified by `instructions.test.ts`)
- `apps/server/src/server/api-router.ts` (HTTP handler truncate helper)
- `apps/server/src/db/migrations/0010_summary_length_check.sql` (new file)
- `apps/server/src/scripts/seed-dev.ts` (audit/trim any seeded summaries > 2 000)
- `apps/plugin/scripts/post-compact.sh` (protocol text)
- `apps/plugin/scripts/_transcript.sh` (tail size + comment)
- `apps/plugin/.hermes-plugin/__init__.py` (`_SUMMARY_MAX_CHARS` is a wire upper-bound; protocol-nudge string at line 313)
- `apps/plugin/.opencode-plugin/plugin.ts` (per-turn flush; rely on server truncate or mirror the cap)
- `apps/plugin/commands/summary.md` (slash command description)
- `apps/plugin/.hermes-plugin/tests/test_lifecycle_calls.py` (tests asserting 20 000-byte write currently)

Affected APIs:

- MCP `memory.session_summary` — new rejection path on overflow.
- HTTP `/sessions/:id/summary` and `/sessions/:id/end` — new server-side truncate before service call.

Load-bearing invariants touched:

- **Append-only memory** — `sessions.summary` is explicitly mutable subject to `summary_final` precedence, so the migration `UPDATE` of existing summaries is consistent with the invariant. The proposal documents this in `design.md` to make the legality explicit (no row DELETE; no immutable column touched).

Downstream contributors should grep for `**BREAKING**` and for `SUMMARY_MAX_CHARS` to find every affected layer.
