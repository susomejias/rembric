## Why

`memory.session_summary` on a long-running conversation is rejected with `session_already_ended`, permanently, and the curated summary can never be persisted. Reproduced live against production 0.24.13 on 2026-07-26. `AgentSessionsService.writeSummary()` (`apps/server/src/services/agent-sessions.ts:281-286`) throws when `existing.status !== 'active'` — rejecting **both** terminal states — and it is the single service call behind both `memory.session_summary` (`apps/server/src/mcp/session-tools.ts:263`) and `POST /api/<slug>/sessions/:id/summary` (`apps/server/src/server/api-router.ts:157`).

The trigger is routine operations, not agent misbehaviour. `abandonStale` runs at `bootstrap.ts:104` and again every 30 minutes at `:248`, keyed on `COALESCE(last_activity_at, started_at)` against `SESSION_ABANDON_AFTER_MS` (default 24h). A `docker compose pull && up -d` to take a release sweeps every still-live session older than the window into `abandoned` — which is exactly how this fired. The session is still open in front of the user; its summary is now unwritable for the rest of its life.

The failure is silent and repeating. The per-turn `Stop` hook transcript sync also POSTs `/summary` (`apps/plugin/scripts/stop-sync.sh`), so on an abandoned row **every** turn's sync 409s with nobody told: `_api.sh:11-12` guarantees every helper exits 0 with output to `/dev/null`. The stored summary is frozen at the instant of abandonment. Worse, the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges explicitly instruct the agent to call `memory.session_summary`, so for any session past the window that instruction is guaranteed to fail. And because `recentForContext` filters on `summary_final = 1` and has no status filter, a late curated summary on an abandoned row _would_ reach the next session's `memory.context` — the payoff is real, the write is just refused.

The asymmetry is between endpoints, not between statuses. `end()` in the same file already **accepts** a late summary/title on `status='ended'` (`:359-374`, via `updateById(..., { requireActive: false })`) while throwing on `abandoned` (`:343`). So `/end` honours a late write on a row that `/summary` 409s on.

A change is mandatory because the rejection is **required** today, and the specs contradict themselves about it:

- `openspec/specs/http-api/spec.md:103` — "Calls on an `ended` or `abandoned` session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row", with the pinning scenario at `:178-181` and the test at `apps/server/src/server/api-router.test.ts:326-340`.
- `openspec/specs/sessions/spec.md:377` justifies the purge grace period as "a 1-hour grace period after end to avoid racing with late-arriving summary writes" — the spec budgets for a write the spec forbids.
- `openspec/specs/plugin-session-protocol/spec.md:50` and `:88` declare `abandoned` the **expected steady state** for Codex CLI and for non-cooperating opencode sessions. It is normal for two of four clients, not an anomaly.
- `openspec/specs/sessions/spec.md:606` describes an auto-curate path `composeDerivedSummary` that **does not exist anywhere in the tree** (it survived from an abandoned branch — see `openspec/changes/archive/2026-07-12-close-session-context-pollution-gap/design.md:40`). The safety net the spec implies is fictional, so nothing compensates for the refused write.

`openspec/specs/sessions/spec.md` is silent on the `writeSummary` status gate and `openspec/specs/mcp-api/spec.md:385-432` states no status precondition, so the MCP side of the contract is currently unspecified in either direction.

## What Changes

- **Terminal session rows accept late summary/title writes.** One rule, stated once: `writeSummary` and `end` both apply the existing `final` precedence to `summary`/`title` on `status IN ('ended','abandoned')`, and neither mutates `status` or `ended_at`. Chosen over an abandoned-only relaxation, which would create a fresh indefensible asymmetry in the other direction given `/end` already accepts on `ended`.
- **Unbounded in time — no lateness window.** Bounding it requires an N larger than a realistic resume gap (days), which is nearly unbounded anyway, and the existing `final` precedence already protects a curated summary from being clobbered by a later raw transcript. A window would add a config knob whose only effect is to reintroduce the defect on the long tail.
- **`end()` on `abandoned` is fixed in the same change** (`agent-sessions.ts:343`), so `/summary` and `/end` land on one rule. The `end()` half is deliberately **not** shippable alone — it does not fix the reported defect, which arrives via `/summary`.
- **`status` and `ended_at` are never mutated.** `end()` on an `abandoned` row does **not** flip it to `ended`: `sessions/spec.md:11` makes `ended_at` write-once and the sweep's judgment stands. The status FSM stays `active → ended | abandoned`, both terminal.
- **Rejected: reviving `abandoned → active`.** It violates `sessions/spec.md:11` and `:51`, and it produces two `active` rows for one `(token, project)` → `findActiveForTransport` returns `undefined` → session auto-attach silently stops for _everything_ on that transport, and `sessions.active` double-counts.
- **Rejected: changing `SESSION_ABANDON_AFTER_MS`, and making read tools touch activity.** Reads not bumping `last_activity_at` is a genuine separate issue — but the fix direction is contested, because bumping on reads weakens the zombie signal that `sessions/spec.md:778` and `findActiveForTransport` depend on. Tracked separately; out of scope here.
- **Excise the fictional `composeDerivedSummary` sentence** from `sessions/spec.md:606`. A spec sentence describing a compensating mechanism that does not exist is worse than no sentence, because it makes the refused write look survivable.
- **Not retroactive.** Existing abandoned rows with a frozen or missing summary are not repaired: the transcripts behind them are gone. This change stops the loss going forward.

## Capabilities

### New Capabilities

(none — this change repairs existing behaviour)

### Modified Capabilities

- `http-api`: `POST /api/<slug>/sessions/:id/summary` no longer rejects terminal rows; the `session_already_ended` requirement at `spec.md:103` and its scenario at `:178-181` are inverted. The `session_deleted` and `session_not_found` rejections, the authz gate, and the truncation rules are unchanged.
- `sessions`: a positive requirement that terminal rows accept late summary/title writes with no `status`/`ended_at` mutation; the `end()` idempotency scenario is extended to cover `abandoned`; the fictional `composeDerivedSummary` sentence is removed from the `SUMMARY_MAX_CHARS` requirement.
- `mcp-api`: a scenario pinning `memory.session_summary` on a terminal row (currently unspecified in either direction).

## Impact

Server:

- `apps/server/src/services/agent-sessions.ts` — `writeSummary` status gate (`:281-286`) and terminal-row branch; `end`'s `abandoned` rejection (`:343`); the two branches converge on one shared precedence-apply path.
- `apps/server/src/server/api-router.test.ts:326-340` — the pinned 409 becomes a 200 asserting `status`/`ended_at` unchanged.
- `apps/server/src/services/agent-sessions.test.ts` — unit coverage for the six terminal-row cases (2 statuses × {writes, precedence-skip, no-op}).
- `apps/server/src/test/invariants.test.ts` — two new invariants: no path sets `sessions.status` back to `'active'`, and `ended_at` is never written twice. Neither is currently covered.
- `apps/server/src/db/schema/agent-sessions.ts` — the FSM docblock (`:24-29`) gains the late-write note; the transition table itself is unchanged.

No changes to: `apps/server/src/mcp/session-tools.ts` (it already calls `writeSummary` and surfaces whatever it returns), `api-router.ts` (the handler already delegates), `apps/plugin/**` (the per-turn sync starts succeeding without edits).

**No migration.** No schema change, no derived-data invalidation (`memory_fts`, `memory_vec` and the entity tables are untouched — session rows are not memory rows). First boot after upgrade is a plain restart; the boot `abandonStale` sweep behaves exactly as before. Rollback re-imposes the 409 on writes that had started succeeding, losing no data already written.

Invariants touched: **append-only memory is untouched** — `sessions.summary`/`title` are already the `final`-precedence mutable columns named in `sessions/spec.md:11`, and no `memory` row is read or written. Scope-at-service-layer is unchanged (the cross-token mask and the `project_id` mismatch mask both run before the status check and stay there). No new MCP tool. The status FSM's terminality is _strengthened_, by an invariant test rather than a comment.
