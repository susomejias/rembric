## Context

Agents use `memory.search` almost exclusively when the user explicitly asks to recall. The search quality is strong (R@8=0.975, MRR@8=0.917), but the triggers are reactive: a keyword regex (`RECALL_REGEX`) and a tool description that says "call this whenever the user references past work or asks 'remember', 'recall'". The first-prompt prefetch (`memory.context` with focus) fires once per session. Long sessions that drift to new topics never recall.

An entity-matching engine already exists in `apps/server/src/mcp/memory-tools.ts:extractEntities()` + `repos.entities.findMemoriesByEntity()`, currently used only by `memory.context`'s focus pass. The turn channel (`POST /sessions/:id/turn`) already carries `{usedTools}` from every client and returns server-composed `lines` that both transports print. The prompt is available client-side (transcript accumulator) but never reaches the server today.

Two description length budgets constrain wording changes: `DESCRIPTION_MAX_LENGTH = 1900` (CI-enforced at `test/mcp-integration.test.ts:379`) for `memory.search`, and `INSTRUCTIONS_MAX_LENGTH = 1000` (CI-enforced at `instructions.test.ts`) for the `instructions.ts` BASE block.

## Goals / Non-Goals

**Goals:**

1. Replace reactive-only recall triggers with proactive-moment triggers in both `SEARCH_DESCRIPTION` and `instructions.ts` RECALL line, within existing length budgets.
2. Surface entity-matched memories proactively on every turn via a dedicated recall-hints endpoint called at turn START, without persisting the prompt.
3. Provide minimal usage observability (tool-call counters) to measure whether proactive recall improves usage.
4. Keep both transports (JS core and bash) symmetric — entity recall hints arrive identically for the four clients that carry them: Claude Code and Codex through the bash hook, opencode and Pi through the JS core. Symmetry here means the observable contract (redaction semantics, the 500-character window, the latency budget, silence on failure), not merely that each client makes a call. Hermes is out of scope by the Non-Goal below and keeps its own `/memory/recall` prefetch; this is a four-client mechanism and no requirement in this change may be read as a five-client claim.

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

**D3: Per-session entity dedupe is process-local, keyed on `(kind, value)`, and bounded.**

Each entity is surfaced at most once per session. The first turn that mentions entity X returns the recall line; subsequent turns mentioning X are silent for that entity. This prevents noise on long sessions where the same files recur.

The key is the entity's `(kind, value)` pair, not the bare value. The extractor admits the same literal under more than one kind, and suppressing every kind on the strength of one match hides a memory the prompt legitimately addressed.

**The state is deliberately NOT stored on the `agent_sessions` row, and the earlier wording of this decision — "same spirit as the session-nudges state" — described the opposite of what that comparison implies.** The nudge clocks (`startedAt`, `lastWorkAt`, `lastSummaryAt`, `lastNudgeAt`) are columns, so they survive a restart and are reclaimed with the row; a dedupe set built the same way would need a column and a migration to buy durability nobody needs, because a lost set costs one repeated hint and nothing else.

Being process-local makes eviction this change's own responsibility rather than the row lifecycle's, and the change owns both bounds: a session's set is released when the session ends or is soft-deleted, and the map holds at most `RECALL_DEDUPE_SESSIONS_MAX` sessions, evicting the least recently used beyond that. A restart clears everything and re-surfaces each entity once, which is accepted and stated here rather than left to be discovered.

Alternatives considered:

- _Per-turn dedup only (no session persistence)_: Would re-surface the same entity every turn that mentions it. Too noisy. Rejected.
- _No dedup, always surface_: Even noisier. Rejected.
- _Dedupe state as a column on `agent_sessions`_: Durable and self-reclaiming, but it buys durability for state whose loss costs one repeated line, at the price of a migration on an append-only table. Rejected.

**D4: Limit to active-learning-type memories only (project, feedback, procedural), filtered in SQL ahead of the row limit.**

Entity-matched memories filtered to `type IN ('project', 'feedback', 'procedural')` — not reference memories. Reference memories are factual and less actionable as recall nudges. The existing `type` field on `memory` provides the filter.

**Where the filter runs is part of the decision, not an implementation detail.** `findMemoriesByEntity` bounds its result with `LIMIT`, so a caller that asks for the two newest rows linked to an entity and then drops the ineligible ones among them returns nothing whenever those two happen to be reference memories — even though the entity has an eligible `project` memory sitting directly behind them. The repository therefore accepts the whole admitted type set and applies it as a SQL predicate, so `LIMIT` bounds rows that already passed the filter. No caller post-filters a bounded page.

**D4b: Recall reads `status = 'active'` explicitly.**

`findMemoriesByEntity` defaults to `status != 'archived'`, which admits `superseded`. That default is correct for exact-address retrieval, where a topic's whole history is the point, and wrong for a hint: the purpose of a `topic_key` supersede is that exactly one row is the current take, so surfacing a superseded row beside its successor hands the model two answers and no way to tell which is live. Recall passes `status: 'active'`; the repository default is unchanged for every other caller.

**D5: ≤3 recall lines per turn, ~200 tokens total, and a bounded probe behind them.**

Bounded by the same principle as the stretch-close notice: server-composed lines must not overwhelm the user's prompt context. ≤3 lines with top-2 memory titles each keeps the total well under 200 tokens. Alternatives:

- _Unbounded_: Could produce dozens of lines on a prompt mentioning many entities. Rejected.
- _1 line_: Too sparse to cover the common case of a prompt mentioning 2-3 entities. Rejected.

**The line cap bounds the ANSWER; the work behind it needs its own bound.** `extractEntities` admits up to 250 entities from one text (`MAX_ENTITIES`), and a prompt naming many indexed identifiers that all resolve to ineligible memories performs one indexed lookup per entity to return nothing at all — the line cap never engages because no line is ever produced. Recall therefore probes at most `RECALL_ENTITY_PROBE_MAX` distinct entities per request, in extraction order, and stops as soon as the line cap is reached.

Measured on the current worst realistic case (a 500-character prompt naming two file paths, an error code, a host, a ticket and a URL, against a seeded entity index, returning the full three lines), over 300 requests through the real HTTP boundary including authentication and JSON: p50 0.78 ms, p95 1.44 ms, max 2.87 ms. `extractEntities` alone is 0.024 ms per call. The probe ceiling is insurance against a pathological prompt, not a fix for a measured problem.

**D6: Usage counters are in-memory, not database — and the recall path counts its own firing.**

Per-token counters of `memory.search`, `memory.context`, `memory.save` calls, reset on server restart. This is the minimum viable observability — enough to measure whether proactive recall increases search usage over a session. Database persistence would require new columns and migration; in-memory counters suffice for the initial measurement.

**Tool-call counters alone cannot answer this change's own question.** They count what the model did, so a session where recall never fired and a session where it fired on every turn are indistinguishable in the numbers. Without the denominator, a flat `memory.search` count is unreadable: it could mean the hints do not help, or it could mean they never appeared. Recall therefore records three of its own numbers per token on the same instance — requests served, requests that returned at least one line, and lines served in total — and the admin debug surface reports them beside the tool counts.

The three are chosen so the ratio is meaningful. Requests give exposure, non-empty answers give the hit rate the entity approach actually achieves on real prompts, and lines served give the token cost being paid for it.

Alternatives considered:

- _Database-persisted counters_: More durable but requires schema migration for a measurement that may be temporary. Rejected for the initial version; can be promoted later if the counters prove useful long-term.

**D7: Description wording changes are paid for within the fixed budgets, never by raising a cap.**

The proactive triggers are ADDED alongside the reactive ones, and the space is reclaimed from clauses no requirement mandates. An earlier wording of this decision said the reactive text would be "replaced… not appended", and that turned out to be unavailable: `mcp-api` publishes a scenario requiring the `memory.search` description to keep instructing the agent to call it when the user asks to recall, so removing the reactive trigger would have retired a published scenario, which this repository does not permit. The two trigger categories are complementary and both survive.

What is normative is the funding rule: no cap is raised, and any clause reclaimed to make room is named by the change that removes it. The clauses this change reclaimed from `SEARCH_DESCRIPTION` are named in the `mcp-api` delta.

The `instructions.ts` BASE block is bound by the same rule and by something stronger — an enumerated list of components the published requirement says the block SHALL contain. Reclaiming space there is only legitimate from prose outside that list. Measured after this change's rewrite, the rendered block is 968/1000 characters unscoped and 906/1000 path-scoped, so no component had to be dropped to fit; a component that went missing did so by accident, not by budget.

**D8: Prompt redaction uses the existing `<private>` mechanism, through each language's canonical implementation, in the order redact → cut → escape.**

The transcript accumulator already strips `<private>...</private>` spans when deriving titles. The same function is applied to the prompt before it is sent to the hints endpoint. No new redaction logic is written in either transport: the JS core calls `stripPrivateTags`, and the bash hook calls `rembric_redact_private` (`scripts/_transcript.sh`), reaching it by sourcing that file alongside `_api.sh` exactly as `prompt-nudge.sh` — the other `UserPromptSubmit` entry — already does, so the load cost is one this channel already pays. A local re-implementation in the hook would be a second bash redaction with its own semantics, and the shared fixtures exist precisely to stop that: they require case-insensitive matching, which a hand-rolled `index()` scan over the raw string does not provide.

**The order of the three steps is normative.** Escaping before cutting can sever a `\uXXXX` or `\"` sequence at the 500-character boundary and emit a body the server rejects as malformed — a silent 400, no hints, nothing in the log the user will ever see. It also measures the window against the escaped string, so the amount of prompt a client actually sends shrinks with the amount of punctuation in it, and the "first 500 characters" in this document stops meaning the same thing in different transports. Redacting first, cutting the real prompt to 500 characters, and escaping last makes the window one number with one meaning everywhere.

**D8b: The turn-start latency budget is the hook's own, not the background POST's.**

The client budget for this call is 200 ms, because it sits between the user's prompt and the model's first token. The JS core enforces it with `AbortSignal.timeout`. The bash transport reaches the network through a shared helper whose default is the 3-second background-POST budget, so the budget has to be set at this call site or the hook inherits the wrong one — measured at 3022 ms against an unresponsive server before this was pinned, against the 200 ms this change's own spec published. Failing open is not enough on this path: the hook already exits 0 and emits nothing, and it was still holding the user's turn for three seconds.

## Risks / Trade-offs

**[Risk] Entity extraction from a short or vague prompt produces poor matches.** A prompt like "fix it" yields no entities, and the recall lines array is empty. → Mitigation: the server returns no lines when extraction finds no entities; the stretch-close notice (if any) still works via the separate turn channel. This is a graceful no-op, not a failure.

**[Risk] The synchronous hints call adds latency at turn start.** Every prompt now pays one additional HTTP round trip before the model responds. → Mitigation, measured rather than estimated: over 300 requests through the real HTTP boundary against a seeded index, on the worst realistic prompt shape, the endpoint answers at p50 0.78 ms, p95 1.44 ms, max 2.87 ms; `extractEntities` alone costs 0.024 ms. The server side is two orders of magnitude inside the 200 ms client budget. What actually threatened this path was not server cost but an unset client budget in the bash transport, which inherited the 3-second background-POST default and was measured holding a turn for 3022 ms; that is D8b, and it is the part this risk needed a guard for.

**[Risk] Entity matching abstains on the prompts the proposal uses to motivate itself.** "Set up the auth module" and "debug this timeout" name no file, error code, ticket or host, so extraction yields nothing and the endpoint correctly returns no lines — on exactly the new-task prompts the Why section holds up as the moment recall matters most. → This is an accepted consequence of choosing precision: the alternative, running the hybrid ranked search on every prompt, returns rows whether or not any are relevant, because the abstention floor is unreachable in production, and would put unfiltered noise in front of the model on every turn. The mitigation is not a wider net but the counters in D6: exposure, hit rate and lines served make the coverage cost a number instead of an assumption, and a low hit rate is the evidence that would justify revisiting the retrieval choice.

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
