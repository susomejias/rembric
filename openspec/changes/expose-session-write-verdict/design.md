## Context

`memory.session_summary` writes summary and title onto a session row. On an `active` row the write always lands (last-final-wins among `final:true` writes). On a terminal row (`ended` or `abandoned`), the write enters `writeTerminalFields`, which calls `precedenceSet` with `{ terminal: true }`. That flag locks summary once `existing.summaryFinal` is already `true` — "first curated value stands" — because on a closed row the owning process is dead and losing a curated handoff is unrecoverable (`openspec/specs/plugin-session-protocol`, "Write precedence for summary and title MUST be expressed via a `final:boolean` flag"). The result: a second curated write on a terminal row is a silent no-op, but the handler returns `ok:true` with the stored summary, which is byte-identical to the caller's input when the summary text happens to match, and byte-different but equally `ok:true` when it does not. The caller cannot tell.

The same pattern exists on `memory.session_end`: `end()` on a terminal row returns the existing row, the handler reports `ok:true` with the existing `endedAt`. This is the explicit idempotent contract (the spec says `session_end` on an already-ended row returns `{ ok: true, endedAt }`), so it is not a bug — but it is the same class of "outcome not legible" and fixing both tools in one change keeps the surface consistent.

The precedent for this fix class: issue #337 fixed `memory.session_start`'s silent agent discard by echoing the effective outcome (`reused` + effective `agent`). The in-flight change `expose-session-start-agent` is the structural template.

Service layer anchoring:

- `writeSummary` (`agent-sessions.ts:375`) calls `writeTerminalFields` when `existing.status !== 'active'`.
- `writeTerminalFields` (`:322`) calls `precedenceSet` with `{ terminal: true }`, gets back a `set`. If `set` is empty (nothing changed), returns `existing`. Otherwise writes `set` via `updateById` and returns the updated row.
- `end` (`:390`) has the same terminal path: calls `writeTerminalFields` when `existing.status !== 'active'`.
- The handler (`session-tools.ts:266`) reads `updated.summary`, `updated.summaryFinal`, etc. from the returned row and emits them. When the terminal write was a no-op, these are the OLD stored values, identical to what the caller sent.

## Goals / Non-Goals

**Goals:**

- A caller of `memory.session_summary` can tell, from the response alone, whether the write landed or was discarded by the terminal precedence rule.
- A caller of `memory.session_end` can tell, from the response alone, whether the call transitioned an `active` row or was a no-op on an already-terminal row.
- The `mcp-api` spec states the new fields, what they mean, and why the terminal discard cannot be an error.
- The reproduction probe's assertions are folded into proper regression tests and the probe file is deleted.

**Non-Goals:**

- Changing the first-curated-stands precedence rule on terminal rows (the spec's `plugin-session-protocol` requires it, and there is no `replaces` chain for sessions to recover from).
- Changing `session_already_ended` error semantics (the spec already says this SHALL NOT be an error code).
- Surfacing a verdict on `memory.session_resume` (it already reports `previousStatus` / `previousEndedAt`, which is the verdict).
- Extending the HTTP API surface (the `POST /api/<slug>/sessions/<id>/summary` path is out of scope, same as in the precedent change's D5).
- Adding operator-facing advice to the tool description (it belongs in `docs/`, not in the model-facing channel).

## Decisions

**D1 — `applied` is a required boolean, not an enum or union.** A boolean answers the one question the caller needs: "did my write land?". Rejected: an enum like `applied | terminal_final | active_noop` — more expressive, but the only case that needs a distinguishing name is the terminal-final discard, and that is the case `discardReason` covers. The boolean keeps the common path cheap and the rare path descriptive. The MCP SDK validates output against the registered schema, so adding an optional `discardReason` is additive and backward-safe: existing callers that do not read it are unaffected.

**D2 — `discardReason` is optional, not required, and only present when `applied: false`.** When `applied: true`, the caller does not need a reason — the write landed. When `applied: false`, the `discardReason` string names why. Today the only value is `'terminal_final'` (the write was skipped because the terminal row already carries a curated summary). Keeping it optional means the output shape is smaller in the common case and extensible for future discard reasons without a schema-breaking change. The zod shape is `z.string().optional()` — present in the `outputSchema` so clients can discover it, but not required.

**D3 — Surface `applied` on `session_end` for consistency, even though the no-op is the documented contract.** The spec already says `session_end` on a terminal row is a no-op returning the existing `ended_at`. Adding `applied` makes the two session-lifecycle write tools consistent: both report whether the call achieved a state change. This matters because `session_end` is called from the same nudge path as `session_summary` — a model that receives `applied: false` on both can reason uniformly about "nothing changed" without special-casing the two tools. Rejected: not adding it (asymmetric surface), adding it only to `session_summary` (then `session_end` has the same class of omission that motivated this change).

**D4 — The service layer must signal "no-op" rather than the handler inferring it.** The handler currently reads the returned row and cannot tell whether `writeTerminalFields` was a no-op (returned `existing`) or a real write (returned `updated`). Two implementation options: (a) change the return type to include a flag (`{ row, applied }`), or (b) the handler compares the returned summary against what it sent and infers. Option (a) is chosen because: inference from the returned row fails when the caller's summary matches the stored one (the same text was written, so the comparison is a false positive), and it introduces a coupling between the handler and the service's storage details. Option (b) is rejected. The same `{ row, applied }` shape applies to `writeTerminalFields` and to `end`, keeping the boundary clean.

**D5 — The spec scenario "last-final-wins among final writes" is scoped to active rows.** The current spec says: "GIVEN a session whose `summary_final = true` … WHEN the agent calls `memory.session_summary({summary: "B"})` again — THEN `summary` SHALL be replaced with 'B' (last-final-wins among final writes)". This is true on active rows and false on terminal rows. The scenario SHALL be updated to scope the claim to active rows, and a new scenario SHALL cover the terminal-final-discard case. This is a spec clarification, not a behaviour change — the code already implements terminal-first-curated-stands — and the scenario was the source of the issue author's expectation that the second write would land.

**D6 — `memory.session_summary`'s tool description SHALL state the terminal-summary rule.** A model that receives `applied: false` with `discardReason: 'terminal_final'` needs to know what to do next: use `memory.session_resume` to reopen the session and write again. The description SHALL add a clause explaining that a terminal row keeps its first curated summary and that `memory.session_resume` is the way to resume the session for further writes. This clause replaces no existing text — it is additive within the `DESCRIPTION_MAX_LENGTH` budget, and the new length shall be measured from a real `tools/list` response.

**D7 — No comment on the schema or handler edits.** The "why" is in the spec and design doc, per house policy.

## Risks / Trade-offs

- [Trade-off] One more REQUIRED field on two tools every model sees → Accepted: the field answers a question the caller cannot answer any other way, and the precedent (#337) established that output-schema fields for observable state are the right remedy class. Budget: two boolean fields cost negligible description space.
- [Trade-off] `session_end` gains `applied` even though its no-op is documented → Accepted: consistency across the two write tools, and the cost is one more boolean. The alternative (leaving `session_end` asymmetric) is the same class of omission this change exists to close.
- [Risk] A test that asserts `applied: false` on a terminal-final discard passes without the terminal row actually being final — the shape of failure the repo has been bitten by before → Mitigation: the distinguishing test creates a terminal row with `summaryFinal: false` and asserts `applied: true` (the write lands on a terminal row that has no curated summary), paired with the control that creates a terminal row with `summaryFinal: true` and asserts `applied: false`. Both arms are required; the `applied: false` arm alone cannot be told from a broken flag.
- [Risk] `discardReason` could be emitted on an active row by accident → Mitigation: the service layer only sets `applied: false` when `writeTerminalFields` returns the existing row; the active path always calls `updateActiveOrThrow`, which either returns the updated row or throws `session_already_ended`. A test asserting `discardReason` is undefined on an active-row write guards this.
- [Trade-off] The HTTP `POST /api/<slug>/sessions/<id>/summary` path keeps its silent discard → Accepted, same reachability argument as in `expose-session-start-agent` D5. The MCP surface is the one the model uses; the HTTP surface is plugin-only and each client already handles its own retry.
- [Risk] Existing terminal-final discards will now return `applied: false`, which is a response-shape change → Mitigation: additive field, not a breaking change; existing callers that do not read `applied` are unaffected. The MCP SDK validates `structuredContent` against the schema published at registration, so schema and payload move together.

## Migration Plan

No migration. No schema change, no new column, no index, no backfill, no derived-data invalidation. Deploy is a `server`-track version bump only. First boot after upgrade: `memory.session_summary` and `memory.session_end` return one additional field each; nothing persisted depends on it. Rollback removes the fields and restores the silent discard; safe in both directions.

## Open Questions

None. The decisions above settle every design choice identified during analysis. The terminal-first-curated-stands rule is correct and not on the table. The `discardReason` shape is extensible for future reasons without a schema change.
