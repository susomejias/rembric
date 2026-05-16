## Context

Operators observe `summary: null` on every session in `/dashboard/sessions`. Investigation traced three bugs that compose:

1. **`pre-compact.sh` POSTs garbage**. The script reads stdin (the hook event metadata `{session_id, transcript_path, hook_event_name, trigger}`) and POSTs that JSON blob verbatim as the summary body. Even if PreCompact fired, the summary would never be the transcript.
2. **`Stop` is wired where `SessionEnd` belongs**. Verified against `code.claude.com/docs/en/hooks`: Stop fires once per assistant turn ("when Claude finishes responding"), not at session end. SessionEnd is the per-session terminator. Our `hooks.json` registers Stop, so on the first turn the session flips to `status='ended'` (because `summarize()` always transitions) and subsequent turns POST `/end` and silently fail with `session_already_ended`. Mid-session `memory.session_summary` calls are also blocked because they fail with `session_already_ended` after Stop has fired.
3. **PreCompact only fires when context is compacted**. In short sessions (a few prompts), it never fires. No fallback exists.

Plus a UX hole: `sessions` table has no `title`. The dashboard list shows only `shortId(id)` and timestamps — operators cannot identify a past session without opening it.

Two reference projects survey the same problem space and converge:

- **`Gentleman-Programming/engram`** (Go): registers `SessionStart` with `matcher: "compact"` (the dedicated "resumed-from-compact" source) and prints an imperative instruction to stdout. SessionStart is one of three Claude Code events whose stdout IS injected into the model's context (verified against docs). The model sees its own compact summary "above" in context plus the imperative, and calls `mem_session_summary` itself.
- **`rohitg00/agentmemory`** (TypeScript): uses Stop hook to POST `/agentmemory/summarize {sessionId}`, the server runs an LLM over previously-saved observations. Quality summary, but requires LLM availability.

Both projects implicitly decouple "write summary" from "transition state" — exactly what our current `summarize()` conflates.

Three clients to support: Claude Code (hooks shell), Codex CLI (hooks shell), Hermes Agent (Python in-process provider). Their hook surfaces diverge in ways the platform forces, not cosmetics:

- Claude Code: SessionStart matcher includes `"compact"`, dedicated `PreCompact`/`PostCompact`/`SessionEnd` events. PostCompact stdout does **NOT** inject to context.
- Codex CLI: no `SessionEnd`, no `PreCompact`/`PostCompact`, no `"compact"` matcher on SessionStart. Stop is per-turn. Stop **requires JSON on stdout** — plain text is "invalid for this event" per docs.
- Hermes: has `initialize`, `on_pre_compress(messages)`, `on_session_end(messages)`, `on_session_switch(new_session_id, parent_session_id)`. Messages list is passed in-process — no transcript file parsing needed.

## Goals / Non-Goals

**Goals:**

- Every session ends with a non-null `summary` and `title` whenever the agent cooperates with the protocol OR the transcript is reachable from the hook.
- Single HTTP contract (`/sessions/<id>/summary`, `/sessions/<id>/end`) shared by all three clients; per-client divergence lives only where the platform forces it.
- Fix the `Stop` vs `SessionEnd` semantic bug as part of the same change (the dashboard data quality bug is downstream of it).
- Add a `title` column and a dashboard column that renders it with a sensible fallback cascade.
- Fix the latent Hermes bug where `on_session_switch` is not handled (compression rotates `session_id` and our provider keeps writing to the dead one).
- Write-once-with-precedence: model-authored summaries (high quality, `final:true`) cannot be clobbered by bash fallbacks (lower quality, `final:false`).

**Non-Goals:**

- Server-side LLM summarisation (`agentmemory` pattern). Considered. Rejected for v1 because it requires LLM availability everywhere Rembric runs; current users include offline / air-gapped setups.
- Backfilling `title` on historical sessions. New rows get a placeholder; existing rows fall through the dashboard cascade.
- A model-callable "Stop+block" pattern that forces the agent to call `memory.session_summary` before allowing stop. Considered. Rejected because it visibly changes agent UX and requires server-side "did this session get a summary call?" state tracking on every Stop.
- Backwards-compatibility with clients that depended on `memory.session_summary` transitioning to `ended` as a side effect. We verified by grep that the only callers are the plugin's own scripts; all are updated in this change.
- Codex-side parity for the "PostCompact" instruction injection — Codex's hook surface does not allow it. We compensate by leaning harder on `initialize.instructions` for Codex specifically.

## Decisions

### Decision 1 · Decouple summary writes from status transitions

`POST /sessions/<id>/summary` writes summary/title without touching status. `POST /sessions/<id>/end` is the sole transition. Both accept `{summary?, title?, final?: boolean}`.

**Why over the current "summarize transitions to ended" design**: the user's observed bug is _caused_ by that conflation. Mid-session refinements (the model calls `memory.session_summary` and later wants to update it; PreCompact wants to checkpoint mid-session) are impossible today. Decoupling restores both.

**Alternatives considered**: keeping `summarize` as transition + adding a new `update_summary` endpoint that doesn't transition. Rejected — two endpoints for one verb is confusing; one endpoint with optional transition (via choosing `/summary` vs `/end`) is cleaner.

### Decision 2 · `final:boolean` flag for write precedence

Writes carry `final:true` (locked once written) or `final:false` (overwritable by other non-final writes, ignored by `final:true` write attempts only if a `final:true` write already happened). Model-authored writes via `memory.session_summary` send `final:true`. Bash/Python hook fallbacks send `final:false`.

**Why**: balances "model wrote good summary, don't clobber it" with "if model didn't, fallback can take multiple swings". Without `final`, either bash always wins (loses quality) or model always wins (loses coverage when model didn't call).

**Alternatives considered**:

- Strict write-once on first write. Rejected — would lock in a bash fallback if hook fires before model.
- Last-write-wins. Rejected — bash fallback at Stop would always clobber model's mid-session summary.
- Server-side quality comparison (longer = better, semantic = better). Rejected — heuristics are fragile and require a decision on every write.

### Decision 3 · Use `SessionStart` matcher `"compact"` (engram pattern), NOT `PostCompact`

Even though Claude Code has a dedicated `PostCompact` event, its stdout does NOT inject into the model's context — verified against `code.claude.com/docs/en/hooks` ("stdout is added as extra context for Claude" applies only to `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`). PostCompact is "side effects only".

`SessionStart` with `matcher: "compact"` fires when a session resumes from auto/manual compaction, and its stdout IS injected into context. This is exactly the path `Gentleman-Programming/engram` uses, with our docs verification confirming it works.

**Why not PostCompact**: writing to its stdout would be a no-op silently. We'd burn implementation effort building a hook that prints to /dev/null from the model's perspective.

### Decision 4 · Codex Stop is the per-turn `/summary` writer

Codex has no `SessionEnd`. The only signal between turns is `Stop`, which fires per-turn. `session-stop.sh` for Codex POSTs `/summary` (writes summary/title, status stays `active`) on every turn, capturing the latest transcript each time. The session stays `active` until the daily `abandonStale` job flips it to `abandoned`.

Codex requires JSON on Stop stdout — verified — so the script ends with `printf '{}'`. Plain text would fail the hook per docs.

**Why this asymmetry vs Claude Code (which uses SessionEnd, posts `/end {summary}` once)**: forced by Codex's hook surface, not a design choice. Documented in the spec as expected divergence.

**Alternatives considered**:

- POSTing `/end` on every Stop. Rejected — transitions on turn 1, blocks subsequent Stop calls from updating with longer transcripts. Same root cause as the current bug.
- Detecting "is this the last Stop of the session" heuristically. Rejected — no signal exists. Would always be guessing.

### Decision 5 · `title` is a stored column, not derived in the dashboard

Add `sessions.title TEXT` nullable. SessionStart writes placeholder `basename(cwd) · HH:MM UTC`. Model `memory.session_summary({title})` overwrites. Bash fallback at SessionEnd / Codex Stop writes the first non-empty assistant message of the transcript truncated to 100 chars.

**Why a column instead of pure derivation in the dashboard**:

- Title is searchable/sortable in future dashboard improvements.
- A stored title means the model's high-quality choice is preserved instead of recomputed at render time.
- Cascade fallback at render time is still cheap (`row.title ?? row.description ?? shortId`) for legacy rows.

**Alternatives considered**: derive in dashboard only. Rejected because the model's `memory.session_summary({title})` write needs somewhere to go that persists across renders.

### Decision 6 · Fix the latent Hermes `on_session_switch` bug in the same change

`agent/memory_provider.py` upstream documents `on_session_switch(new_session_id, parent_session_id, reset)` as firing on compression among other events. Our provider doesn't override it, so `self._session_id` becomes stale after compression. All subsequent `on_pre_compress` and `on_session_end` posts would target the wrong session id.

This is technically a separate bug, but it lives in the same file as the change we're making and would invalidate our `on_session_end` summary fix the moment compression happens. Fixing it in the same change avoids a known-broken interim state.

**Behaviour**: on `on_session_switch`, POST `/end` for the old session id (with the latest `_format_transcript` we have, if `parent_session_id` matches), then POST `/sessions` for the new session id.

### Decision 7 · Reinforce `initialize.instructions` rather than ship a skill

Adding to the existing MCP server `instructions` string (loaded into the model's system prompt at initialize) covers all three clients uniformly. The new sentence reads:

> "Before saying 'done', call `memory.session_summary({title, summary})`. Title ≤100 chars describing what was actually worked on. Summary follows Goal · Discoveries · Accomplished · Next Steps · Files."

**Why not a skill / a separate per-client doc**: the dashboard data-quality contract is the same across clients. Pushing it into MCP `instructions` is the existing mechanism for this kind of cross-client protocol (proactive-save, recall triggers, topic-key family — all live there). Skill duplication was already rejected in `claude-code-plugin` spec.

**Constraint**: `initialize.instructions` is capped at 800 chars by `instructions.test.ts`. The new sentence is ~180 chars; we must shave equivalent space from less-load-bearing content if we exceed the budget. The session-protocol instruction is high-value (it directly determines summary quality) and should win.

## Risks / Trade-offs

- **[Risk] `SessionStart matcher:"compact"` fires when the session was resumed mid-compact, but the model's context window doesn't necessarily contain the compact summary in an obvious position.** → **Mitigation**: engram's production usage validates the pattern. We add an implementation spike to dump the model's `messages` at that moment from our test session, confirming the compact summary is reachable via "above". If not, we'd fall back to the same instruction without the "above" reference and rely on the model to reconstruct from memory.

- **[Risk] `transcript_path` JSONL format is undocumented; the bash transcript formatter could break when Claude Code changes it.** → **Mitigation**: defensive parser that extracts `role` and `content` fields with grep/sed and accepts unknown fields. If parsing fails, POST `/end {}` (no summary, no title) — degrades to current behaviour rather than corrupting data. Add an issue link in the script comment so future readers know where the format-coupling lives.

- **[Risk] Codex sessions never transition to `ended` cleanly; they pile up in `abandoned` after the daily sweep.** → **Mitigation**: this is the contract. Document it in `codex-distribution` spec. Operators querying "ended" sessions in dashboard get clean Claude data; "abandoned" is the expected state for Codex. We add a per-status filter or label in the dashboard if it gets noisy.

- **[Risk] Backwards-compat: any user with a custom script calling `memory.session_summary` as their "end session" mechanism will see status stay `active` after this change.** → **Mitigation**: documented breaking change in the proposal. Verified by grep there are no such callers in our codebase. Released under a minor version bump with a CHANGELOG warning in `plugin/CHANGELOG.md`.

- **[Risk] `final:boolean` semantics are subtle. A developer adding a third writer (e.g. an admin manual summary edit) might choose the wrong default.** → **Mitigation**: doc the semantic in the `sessions` spec; default in code is `false` (overwritable); `true` is opt-in for "I am the canonical writer". Future admin edits would set `true`.

- **[Risk] Hermes `on_session_switch` fix is partial — we close old + open new, but transcripts that span the switch boundary are split into two summaries (old half and new half).** → **Mitigation**: accepted. Splitting at compression boundary is what Hermes does internally anyway; the alternative (keeping one session id across the switch) requires negotiating with Hermes upstream. Document as known limitation.

- \*\*[Trade-off] The placeholder title `basename(cwd) · HH:MM` is informative but ugly for sessions where cwd is something like `/tmp/test` or `~`. → Acceptable; the placeholder is explicitly transitional and gets overwritten the moment the model or bash fallback runs.

## Migration Plan

1. **Migration SQL**: `ALTER TABLE sessions ADD COLUMN title TEXT;` (additive, no-default, safe for the append-only invariant since it's a new column).
2. **Deploy server first** (extends `/summary` and `/end` bodies; old bodies still work because new fields are optional).
3. **Bump plugin version** in all three manifests. Plugin clients update independently; new bash scripts work against new server because new fields are optional.
4. **Existing rows**: `title=null` for everything historical. Dashboard cascade renders them as `description ?? shortId`. No backfill.
5. **Rollback**: revert server endpoints (old behaviour ignores `title` and `final`). Revert plugin version. Sessions data stays consistent because writes are append-only/idempotent. The `title` column is left in DB harmlessly.

## Open Questions

- None blocking. The two transcript-shape spikes mentioned under Risks are implementation-time confirmations, not spec questions.
