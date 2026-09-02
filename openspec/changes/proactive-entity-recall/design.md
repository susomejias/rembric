## Context

Agents use `memory.search` almost exclusively when the user explicitly asks to recall. The search quality is strong (R@8=0.975, MRR@8=0.917), but the triggers are reactive: a keyword regex (`RECALL_REGEX`) and a tool description that says "call this whenever the user references past work or asks 'remember', 'recall'". The first-prompt prefetch (`memory.context` with focus) fires once per session. Long sessions that drift to new topics never recall.

An entity-matching engine already exists in `apps/server/src/mcp/memory-tools.ts:extractEntities()` + `repos.entities.findMemoriesByEntity()`, currently used only by `memory.context`'s focus pass. The turn channel (`POST /sessions/:id/turn`) already carries `{usedTools}` from every client and returns server-composed `lines` that both transports print. The prompt is available client-side (transcript accumulator) but never reaches the server today.

Two description length budgets constrain wording changes: `DESCRIPTION_MAX_LENGTH = 1900` (CI-enforced at `test/mcp-integration.test.ts:379`) for `memory.search`, and `INSTRUCTIONS_MAX_LENGTH = 1000` (CI-enforced at `instructions.test.ts`) for the `instructions.ts` BASE block.

## Goals / Non-Goals

**Goals:**

1. Replace reactive-only recall triggers with proactive-moment triggers in both `SEARCH_DESCRIPTION` and `instructions.ts` RECALL line, within existing length budgets.
2. Surface entity-matched memories proactively on every turn via a dedicated recall-hints endpoint called at turn START, without persisting the prompt.
3. Provide minimal usage observability (tool-call counters) to measure whether proactive recall improves usage.
4. Keep both transports (JS core and bash) symmetric — entity recall hints arrive identically for all five clients.

**Non-Goals:**

- PostToolUse hooks (retired by owner decision 2026-07-12).
- Resolve/suppress push controls (archive/supersede suffice — YAGNI).
- Prompt persistence (append-only invariant: prompt is extracted and discarded).
- Per-turn channel for Hermes (documented gap, separate change).
- Turn-cadence search nudges (rejected as noise).
- Dashboard display of usage counters (optional later).

## Decisions

**D1′: Hints computed at turn START via a dedicated lightweight endpoint.**

The client calls `POST /api/<slug>/sessions/:id/recall-hints` with `{prompt}` synchronously before the model responds. The server extracts entities from the prompt, matches the entity index, applies the same filters and dedupe as designed (active learning-type memories only: project/feedback/procedural; per-session per-entity first-appearance dedupe; ≤3 lines with inline titles of top-2 matches, ~200 tokens), and returns `{lines: string[]}`. The client merges these lines into the system prompt or nudge context so the model sees them from its first token on the topic.

This is process-and-discard: the prompt is never persisted anywhere (append-only invariant; dedicated non-persistence test stays). The same `<private>` redaction and 500-char window that were designed for the turn body move to the hints path unchanged.

Alternatives considered:

- _Entity recall lines ride the turn channel (original D1)_: The turn channel fires at turn END and returns lines that print at the START of the NEXT turn. This leaves the entire first agentic run on any new mid-session topic cold — precisely the moment proactive recall exists to cover. The owner identified this as unacceptable; one-turn delay defeats the purpose of proactive recall.
- _New `/memory/recall` endpoint called by the agent via MCP_: More flexible but requires the agent to decide when to call it — the exact reactive pattern we are trying to escape. Rejected because we want server-driven proactive recall that the agent cannot skip.

**D2: (RETIRED) Client sends prompt in turn body.**

The original D2 — client sends prompt in the turn body alongside `usedTools` — is retired. The turn body stays `{usedTools}` (+title once) exactly as today. The hints call carries the prompt instead. The privacy mitigations (D8 redaction, 500-char window) move to the hints path; no privacy property is weakened.

**D3: Per-session entity dedup keeps lines sparse.**

Each entity is surfaced at most once per session. The first turn that mentions entity X returns the recall line; subsequent turns mentioning X are silent for that entity. This prevents noise on long sessions where the same files recur.

The dedupe state lives server-side, transient, same spirit as the session-nudges state. Sessions without prior state get no lines.

Alternatives considered:

- _Per-turn dedup only (no session persistence)_: Would re-surface the same entity every turn that mentions it. Too noisy. Rejected.
- _No dedup, always surface_: Even noisier. Rejected.

**D4: Limit to active-learning-type memories only (project, feedback, procedural).**

Entity-matched memories filtered to `type IN ('project', 'feedback', 'procedural')` — not reference memories. Reference memories are factual and less actionable as recall nudges. The existing `type` field on `memory` provides the filter.

**D5: ≤3 recall lines per turn, ~200 tokens total.**

Bounded by the same principle as the stretch-close notice: server-composed lines must not overwhelm the user's prompt context. ≤3 lines with top-2 memory titles each keeps the total well under 200 tokens. Alternatives:

- _Unbounded_: Could produce dozens of lines on a prompt mentioning many entities. Rejected.
- _1 line_: Too sparse to cover the common case of a prompt mentioning 2-3 entities. Rejected.

**D6: Usage counters are in-memory, not database.**

Per-token counters of `memory.search`, `memory.context`, `memory.save` calls, reset on server restart. This is the minimum viable observability — enough to measure whether proactive recall increases search usage over a session. Database persistence would require new columns and migration; in-memory counters suffice for the initial measurement.

Alternatives considered:

- _Database-persisted counters_: More durable but requires schema migration for a measurement that may be temporary. Rejected for the initial version; can be promoted later if the counters prove useful long-term.

**D7: Description wording changes are swaps, not additions.**

Within the fixed length budgets, reactive trigger text is replaced with proactive trigger text — not appended. This avoids raising the caps and keeps CI enforcement honest.

**D8: Prompt redaction uses the existing `<private>` mechanism.**

The transcript accumulator already strips `<private>...</private>` spans when deriving titles. The same function is applied to the prompt before it is sent to the hints endpoint. No new redaction logic is needed. The prompt is truncated to 500 characters before inclusion, matching the original design.

## Risks / Trade-offs

**[Risk] Entity extraction from a short or vague prompt produces poor matches.** A prompt like "fix it" yields no entities, and the recall lines array is empty. → Mitigation: the server returns no lines when extraction finds no entities; the stretch-close notice (if any) still works via the separate turn channel. This is a graceful no-op, not a failure.

**[Risk] The synchronous hints call adds latency at turn start.** Every prompt now pays one additional HTTP round trip before the model responds. → Mitigation: `extractEntities()` is synchronous regex-based; `findMemoriesByEntity()` is an indexed SQLite lookup. Both are fast on the existing corpus (70 rows, indexed entity tables). The total should be well under 50ms. The endpoint is lightweight (no persistence, no session writes) and can be bounded with a timeout. The latency is on the synchronous path, but it replaces a decision the agent would otherwise spend tokens making poorly.

**[Risk] Description wording changes break the CI length assertion.** The new wording must fit within DESCRIPTION_MAX_LENGTH (1900) for `memory.search` and INSTRUCTIONS_MAX_LENGTH (1000) for instructions. → Mitigation: wording is measured during implementation and recorded in the tasks; CI catches any overflow at build time.

**[Risk] Prompt sent to hints endpoint could be logged or cached.** → Mitigation: the endpoint is process-and-discard by construction; no persistence, no info-level logging (same invariant as the original turn-body design). A dedicated non-persistence test enforces this.

**[Trade-off] In-memory counters are lost on restart.** → Accepted because the initial goal is measuring whether usage increases over a session, not long-term analytics. Database promotion is a separate, small follow-up if needed.

**[Trade-off] Per-session dedup means a genuinely new context for the same entity is suppressed.** If the user reverts to file X after working on Y, the second mention of X won't re-surface it. → Accepted because the one-shot surface is the common case (mentions of the same entity in one conversation), and the agent can always call `memory.search` explicitly for anything the proactive line missed.

## Rejected Alternatives

**Turn-channel next-turn print (original D1/D2 transport).** The server computes recall lines at turn END via the turn body, clients print them at START of the NEXT turn. Owner correctly identified this leaves the ENTIRE first agentic run on any new mid-session topic cold — which is precisely the moment proactive recall exists to cover. One-turn delay is unacceptable; not acceptable-with-measurement.

## Migration Plan

**No schema migration required.** The new `POST /sessions/:id/recall-hints` endpoint is additive; the turn body is unchanged. The entity tables and memory tables are untouched.

**Backward-safe on existing installations:** Old client + new server → no hints call → no entity recall lines → existing behavior unchanged. New client + old server → hints endpoint does not exist (404) → client ignores the failure (fallback to no lines) → existing behavior unchanged.

**Rollback:** Downgrading to a pre-change image leaves no new columns, no new tables. The hints endpoint does not exist and the client's hints call returns 404, which is harmlessly ignored.

## Open Questions

None. All design decisions are resolved by the constraints above. The one genuinely open question — whether to persist usage counters in the database for long-term analytics — is explicitly deferred to a follow-up (D6 rationale).
