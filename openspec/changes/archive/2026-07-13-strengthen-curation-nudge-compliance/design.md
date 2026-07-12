## Context

The per-turn curation nudge is delivered on all four clients but frequently ignored. This session established — with ground-truth evidence, not assumption — that it is a **compliance** problem, not a delivery/plumbing one:

- **Claude Code**: the user captured the agent explaining it _saw_ the `rembric: call memory.session_summary…` hook and _chose_ not to obey because the trivial test content "wasn't memorable; saving it would be noise." Delivery works; the model exercised judgment.
- **Hermes**: traced against `NousResearch/hermes-agent@main`. `system_prompt_block()` is consumed unconditionally (`memory_manager.py:456-473`; NOT gated by the `plugin.yaml` `hooks` array — a prior repo gotcha was wrong for memory providers). `prefetch()`'s return is injected into the user message every turn wrapped in `<memory-context>` as _"reference data"_, and our `<memory-hint>` survives verbatim (`turn_context.py:559`, `memory_manager.py:495-515`, `conversation_loop.py:801-812`). Hermes's own **open issue #46955** states the injection plumbing is solved and "what is missing is a behavioral instruction" — a prompt-side fix. RFC #3943 notes the system prompt is frozen per session (stale by ~turn 10), so the live per-turn surface matters most.

Current nudge text is soft/advisory. The save nudge is already work-conditioned ("if recent work produced a decision, fix, or discovery…"); the summary nudge is not ("call memory.session_summary now — …"). All four clients share the text byte-identical via `apps/plugin/test/nudge-fixtures.json`, enforced by `nudge-fixtures.test.ts`. Cadence: summary on turn 1 and every 10; save every 5.

Separately, Hermes writes a derived title only in `on_session_end` — which in practice rarely fires (sessions stay `active`) — leaving the generic placeholder (`.HERMES · HH:MM UTC`). The other three clients already send a derived title every turn.

## Goals / Non-Goals

**Goals:**

- Raise the probability the model curates a real work session by reframing the nudge from passive advisory to a **calibrated imperative** — uniform, byte-identical, across all four clients.
- Give Hermes per-turn title parity so a real title appears from turn 1 without depending on `on_session_end` or model compliance.

**Non-Goals:**

- Guaranteeing curation (impossible client-side; see Decisions D4/D5).
- Changing nudge cadence.
- Any server-side LLM work or new MCP tool / HTTP endpoint / DB migration.

## Decisions

### D1: Calibrated imperative, NOT a blind imperative

The nudge becomes a directive to act, but **conditioned on real, memorable work** (decision, fix, discovery, files changed), explicitly preserving the model's discretion to skip trivial turns.

- **Why**: the captured Claude Code agent was _correct_ to skip a trivial session. A blind "always curate before ending" would break that good judgment and flood Rembric with vacuous summaries — strictly worse than no summary.
- **Alternatives**: (a) blind imperative — rejected, induces noise; (b) keep advisory — rejected, it is the failing status quo for real work.

### D2: Change text in the shared fixture + BASE, never per-client divergence

Edit `nudge-fixtures.json` (`save`, `summaryCore`, `summary`), the server `instructions.ts` `BASE`, and the four call sites (`prompt-nudge.sh`, opencode `plugin.ts`, Hermes `_SAVE_HINT`/`_SUMMARY_HINT` + `system_prompt_block`) in lock-step; update `nudge-fixtures.test.ts`. Keep Hermes `system_prompt_block()` byte-identical to `instructions.ts` `BASE`, and `BASE` ≤1000 chars (`instructions.test.ts`).

- **Why**: parity is enforced by invariant/lock-step tests and is a hard repo discipline.
- **Alternative**: per-client wording — rejected, breaks parity tests and the single-copy contract.

### D3: Hermes title parity via `sync_turn`, reusing `_derive_title_from_messages`

`sync_turn` already POSTs `/summary {summary, final:false}` every turn on a background thread; add the derived title to that body. The server already accepts `title` on `/summary` and `writeSummary` runs `applyPrecedence` on title, so no server change is needed.

- **Why**: the client has the structured `messages`; the derivation function already exists and is spec-locked ("`_derive_title_from_messages` … unchanged"). `final:false` + `applyPrecedence` means a later model-authored `final:true` title still wins, and among non-finals last-write-wins with a stable derived value.
- **Alternatives**: (a) derive server-side from the raw summary string — rejected, fragile parsing of a flattened transcript when the client has structured data; (b) leave title in `on_session_end` only — rejected, it rarely fires.

### D4 (rejected): server-side LLM curation

Reverses the archived `remove-llm-consolidation` decision — the server is a deterministic SQLite+HTTP process ("one secret and go"), no LLM, no API key, no cron. Re-introducing outbound LLM to curate raw transcripts contradicts that identity and is out of scope.

### D5 (rejected): blocking/forcing turn completion

Only Claude Code's `Stop` hook can force continuation (`decision:block`), and even that only injects a `reason` and "hopes the model complies" — it cannot force a specific tool call. opencode and Hermes are in-process with no turn-blocking or forced-tool-call capability (`session.idle`/`on_session_end` are not model-facing). A forcing approach would be non-uniform across clients and still not guarantee compliance, so it is rejected.

## Risks / Trade-offs

- **[Risk]** A poorly calibrated imperative induces noise (summaries/saves of trivial sessions). → **Mitigation**: explicitly condition on real memorable work and preserve skip-discretion in the text; validate against a real work session, not the message-counter test.
- **[Trade-off]** Does not guarantee curation. → **Accepted because** it is impossible client-side (confirmed by Hermes #46955); the raw-transcript floor (`relax-session-purge-bar`, already shipped) means no data is lost even when the model skips.
- **[Risk]** Smaller ceiling on Hermes: the host wraps the per-turn hint as _"reference data"_ (not controllable) and the system prompt goes stale ~turn 10. → **Mitigation**: strengthen both `system_prompt_block` and the per-turn hint; accept the host-imposed limit.
- **[Trade-off]** The message-counter test will still show no summary. → **Accepted because** that is correct behavior (trivial content); real validation is a genuine work session.

## Migration Plan

No DB migration. Text edits + one client-side derivation. Rollback = revert the commit. Single unified `plugin` version bump. Validate e2e against `pnpm run dev:docker:up` per the `rembric-plugin-development` skill.

## Open Questions

- Does the turn-1 summary nudge still make sense under work-conditioned phrasing (turn 1 has no work yet)? Kept for now (cadence change is out of scope); revisit during real-session validation.
- Exact literal wording of the calibrated imperative is finalized during apply, within the ≤1000-char `BASE` budget and keeping the nudge terse.
