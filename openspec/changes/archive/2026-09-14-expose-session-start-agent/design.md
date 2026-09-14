## Context

`memory.session_start` has two exits. When `findActiveForTransport` returns a row for the caller's `(tokenId, projectId)`, the handler adopts it, sets `reused = true`, and touches its activity clock (`apps/server/src/mcp/session-tools.ts:207-213`). Otherwise it inserts, and only there does `args.agent` reach the database (`:219`, `agent: args.agent ?? 'unknown'`). The response is the same shape either way and names no `agent` (`:79-86` for the schema, `:242-249` for the payload).

The reuse itself is deliberate and specified (`openspec/specs/mcp-api/spec.md:2807`). It exists because every supported host registers the session over HTTP before the agent runs, so a model that defensively calls `memory.session_start` would otherwise fork a second session on top of the host's. Issue #337 accepts that and targets the two narrower facts: the `agent` argument is dropped on the adopt path, and no field in the response lets the caller notice.

Three constraints bound the design, and together they decide it:

1. **`sessions.agent` is immutable.** `openspec/specs/sessions/spec.md:11` — "The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session" — with a CI invariant scenario at `:26-30` failing the build on any `UPDATE agent_sessions SET agent = ?`. Honouring a differing `agent` on adopt is therefore not an available option; it is a spec violation.
2. **There is no repair verb.** `AgentSessionsService` exposes no way to re-attribute a session, so a misattribution is permanent for the row's life, and every `memory` row and `session_summary_versions` row anchored to it inherits it.
3. **The response is the only channel.** The MCP tool's caller is a model. It gets the description and the payload; nothing else. A discard the payload does not mention did not happen as far as the caller can tell.

The trigger requires two agents to share a `(token, project)` pair. That is not the documented setup — the dashboard issues per-agent tokens and `docs/agents.md` recommends them — but nothing enforces it, and the TUI installer prompts for a token per client without objecting to the same value being pasted into all five.

## Goals / Non-Goals

**Goals:**

- A caller of `memory.session_start` can tell, from the response alone, which `agent` the session it is now writing into is attributed to.
- The distinguishing case is covered by a test that fails if the field is populated from the argument instead of the row, with a control that proves the test exercised adoption rather than a fresh mint.
- The published `mcp-api` contract states the new field, why the adopt path cannot honour a differing argument, and why refusal and re-keying were rejected — so a later reader does not re-propose them.

**Non-Goals:**

- Fixing the misattribution. This change makes it observable; it does not prevent it, and by constraint 1 it must not repair it.
- Preventing two agents from sharing a token (installer warning, dashboard flag, or per-agent token enforcement). See Open question 1.
- Changing the reuse rule, its key, or `findActiveForTransport` in any way.
- Extending the HTTP `POST /api/<slug>/sessions` response (D5).
- Surfacing `description` (D2).

## Decisions

**D1 — Report the attribution; do not repair it, refuse it, or re-key the lookup.** The response gains `agent`, and the adopted row is left exactly as it was. The three alternatives, and why each is worse:

- _Repair the row on adopt_ (write `args.agent` over the adopted row's value): forbidden by `openspec/specs/sessions/spec.md:11` and caught by the invariant test at `:26-30`. It also destroys information — the row's first attribution is the true one for the writes already anchored to it.
- _Refuse the reuse on mismatch_ (#337 Option 2): the ordinary case is a host-registered row whose `agent` string was chosen by the hook while the model passes its own; refusing there breaks the path the reuse exists to serve, to punish a case the same code cannot distinguish from it.
- _Add `agent` to the reuse key_ (#337 Option 3): genuinely separates agents, and thereby recreates the duplicate-session bug the reuse was introduced to prevent — the model's defensive call with a different string would mint a parallel row again.

Reporting is the only remedy that leaves both the reuse rule and the append-only session contract intact, and it is the prerequisite for anything a client might do about it (use its own token, or stop passing an `agent` it cannot honour).

**D2 — `agent` only; `description` is deferred, not overlooked.** `args.description` is discarded on the same branch. It stays out because it is nullable, so `description: null` in a response cannot distinguish "the adopted row has none" from "yours was dropped"; because it is a seed goal rather than an attribution key, so no downstream row is misfiled by losing it; and because it is not a filter dimension anywhere (`AdminSessionFilters` filters on `agent`, not `description` — `apps/server/src/db/repositories/agent-sessions-repository.ts:50-56`). Every REQUIRED output field also costs a line of the `Returns:` list the model reads on every call. Recorded as a deferred item in `tasks.md` so a future reader finds the decision rather than the omission.

**D3 — The field reads the row, not the branch.** One expression after the if/else: `agent: session.agent`. `findActiveForTransport` returns the whole `AgentSession` (`apps/server/src/services/agent-sessions.ts:497-511`) and `start()` returns the inserted row, so both branches already hold the persisted value and no new service or repository method is needed. Rejected: computing it per branch (`args.agent ?? 'unknown'` on the mint path, `session.agent` on the adopt path). The two agree today, but a per-branch value reports what the handler _intended_ while the point of the field is to report what the row _is_ — the same class of divergence this change exists to close.

**D4 — `agent` is REQUIRED and non-nullable.** The column is `text('agent').notNull()` (`apps/server/src/db/schema/agent-sessions.ts:51`) and the mint path substitutes `'unknown'`, so no reachable state produces an absent or null value. `z.string()`, not `z.string().nullable()` or `.optional()`: a nullable field would publish a state the tool cannot produce, which `openspec/specs/mcp-api/spec.md:2529` classifies as a defect in its own right.

**D5 — No HTTP delta.** `POST /api/<slug>/sessions` has the same shape of omission: it reports `created` but not `agent` (`apps/server/src/server/api-router.ts:124-132`), and `AgentSessionsService.ensure` likewise ignores `input.agent` on an idempotent hit (`apps/server/src/services/agent-sessions.ts:205-218`). It is out of scope because its adopt path keys on the **host session id** the caller itself supplied, not on `(token, project)`: reaching it needs two clients to collide on one host session id, whereas the MCP path adopts across agents by construction. Extending it would need an `http-api` delta and a second round of client-facing contract text for a case #337 does not report. Tracked as a follow-up in `tasks.md`, phrased as a question to verify rather than a defect to assert.

**D6 — The description states the mismatch, not just the field name.** `mcp-api`'s description/response requirement already forces the `Returns:` list to name every required field, and `apps/server/src/test/mcp-integration.test.ts:811-825` enforces it mechanically. Naming it is not sufficient: a model reading `agent` in a return list will read it as an echo of its own argument, which is the exact misreading this change exists to prevent. The description therefore also says that on `reused: true` this is the adopted session's own attribution and may differ from the `agent` passed. Budget: `DESCRIPTION_MAX_LENGTH = 1900` (`apps/server/src/mcp/server.ts:128`) against this tool's pinned measurement of 616 (`apps/server/src/test/mcp-integration.test.ts:746`) leaves 1284 chars, so no clause is reclaimed and none needs naming. The new length is measured from a real `tools/list` response, never computed from the source constant, and the pin is updated to the measured value.

**D7 — The description does not carry the operator remedy.** "Use a per-agent token" is advice the model cannot act on; it belongs where the operator reads it, and `docs/agents.md` already recommends per-agent tokens. Spending description budget on it would trade model-facing contract for operator-facing advice on the wrong channel.

**D8 — No derived mismatch flag.** No `agentDiscarded: true` (or similar) field. The caller knows the `agent` it passed and now receives the one in force, so a boolean adds nothing it cannot compute, while adding a field whose value is a function of two others the same payload already carries.

## Risks / Trade-offs

- [Trade-off] The misattribution still happens; only its visibility changes → Accepted because the two fixes that would prevent it each break something load-bearing (D1), and because visibility is the prerequisite for a client-side or operator-side remedy. The proposal and the spec both say so explicitly, so no reader can mistake this change for a repair.
- [Trade-off] One more REQUIRED field on the tool every model sees, plus the clause explaining it, on a description already 616 chars → Accepted: 1284 chars of measured headroom, and the field answers a question the caller cannot answer any other way. Re-measured in `tasks.md`, not assumed.
- [Risk] A test that asserts `agent` on the adopt path passes without ever adopting — the shape of failure the repo has been bitten by three times → Mitigation: the adopt assertion is paired with a fresh-mint control in the same test (`reused: false` must report the passed `agent`), plus a row-count control proving one row, and the change is gated on `scripts/mutate.mjs` reddening when `agent: session.agent` is replaced with `agent: args.agent ?? 'unknown'`. A mutation that keeps the tests green means the tests prove nothing, and the tests are what get fixed.
- [Risk] Populating from the argument instead of the row would look correct in every single-agent test, since the two values agree whenever one agent owns the token → Mitigation: the distinguishing test creates the row with one `agent` and calls the tool with a different one, so the two candidate implementations disagree observably; that is also exactly the mutation above.
- [Trade-off] The HTTP twin keeps its silent discard (D5) → Accepted, with the reachability argument recorded and a follow-up task to verify rather than assert it.
- [Risk] Existing misattributed sessions stay misattributed and the new field will now display the "wrong" agent for them → Mitigation: that is the true stored value and reporting it is the point; the spec text states that no retro-repair occurs and that the `sessions` capability forbids one.

## Migration Plan

No migration. No schema change, no new column, no index, no backfill, no derived-data invalidation (`memory_fts`, `memory_vec` and the three entity tables regenerate from `memory` and are untouched). No table rebuild, so the `PRAGMA foreign_keys` dance in `apps/server/src/db/migrate.ts` is not involved.

Deploy is a `server`-track version bump only; `publish-docker` gates on `server_release_created` and the `plugin` track is untouched because no file under `apps/plugin/` changes. First boot after upgrade behaves identically except that `memory.session_start` returns one additional field. Rollback removes the field and restores the silent discard; nothing persisted depends on it, so rollback is safe in both directions and needs no data step.

## Open Questions

1. **Should a follow-up make sharing one token across agents hard rather than merely visible?** The candidates are an installer warning when the same token is pasted for a second client, a dashboard indicator when one token has sessions under more than one `agent`, or nothing at all. Default taken here: nothing in this change — #337 scopes itself to observability, and each candidate touches a different surface (`apps/plugin/install.sh`, `apps/server/src/dashboard/`) with its own contract. Resolve after the field has been shipped and the condition can actually be observed in the field.
