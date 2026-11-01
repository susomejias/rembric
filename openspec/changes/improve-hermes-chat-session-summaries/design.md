## Context

Local server-policy implementation and focused regressions are authorized. This design does not establish a diagnosis of the deployed bot; actual gateway acceptance remains separate.

Current contract evidence:

- `openspec/specs/session-nudges/spec.md:37`: "an absent `last_work_at` means \"no work has been reported\" and fails (1), so a session that only converses is never reminded".
- `openspec/specs/http-api/spec.md:567-569`: "a client POSTs `{ usedTools: false }`" currently yields "`200` with `lines: []`".
- `openspec/specs/hermes-agent-plugin/spec.md:402`: "The transcript POST itself is UNCHANGED and SHALL NOT be removed". This proposal preserves that fallback.

Source inspection: `AgentSessionsService.reportTurn` reads the old `lastTurnReportAt`, writes it on every active report, but updates `lastWorkAt` only for `usedTools:true`. `evaluateSessionNudge` requires `lastWorkAt`; the exported floor in `agent-sessions.ts` is 25 minutes. The service test explicitly pins three hours of chat without notices. These are deliberate current semantics; broadening eligibility is a policy change, not proof of a defect in that implementation.

Executed here: `PYTHONDONTWRITEBYTECODE=1 python3 /tmp/rembric-hermes-summary-probe.py` passed all provider probes using mocked HTTP and a host double. Primary initialize ensures/resumes before any content; suppressed subagent is the no-request control. Opening fires once; ordinary later chat has no dynamic reminder without returned lines; recreated same-ID `created:false` gets resumed-read. Lifecycle summary writes remain `final:false`; tool observations discriminate chat, calls, results, prior-turn tools and missing messages. A blocked asynchronous report produces no early notice, then one later delivery, consumed once. This proves adapter behavior, not gateway hook delivery, real persistence or model cooperation. The probe is an external diagnostic, not a portable committed regression test.

Parent-reported prior validation: 111 Hermes unittest tests; core 1022 passed / 1 skipped. Those counts were not independently rerun here and are not evidence for the proposed policy.

Upstream API source was read from public `NousResearch/hermes-agent/main` (moving source, not the unknown deployment): `agent/memory_provider.py:138-156` specifies cache-only prefetch and nonblocking completed-turn sync with `messages`; `:167-192` separates queue cleanup at shutdown from real-boundary extraction at `on_session_end` and rebinding at `on_session_switch`. `agent/memory_manager.py:444-469` forwards optional message kwargs by accepted signature; `:616-634` directly dispatches provider methods; `:855-867` implements soft release/cache eviction WITHOUT session end, then shutdown. Thus a shutdown hook cannot simply be treated as `/end`. A guessed developer-doc URL returned HTTP 404; conclusions above use the successfully fetched source, not that missing page. Existing skill/spec claims that manifest `hooks` gates provider invocation conflict with direct upstream dispatch; merely adding a manifest entry is not a verified fix.

## Goals / Non-Goals

**Goals:** Permit conversation-only activity to earn the existing reminder; keep one server policy and floor; protect curated writes and reliable identity; establish explicit gateway acceptance gates for RAW and empty-session reports.

**Non-Goals:** Guarantee curation, generate server-side LLM summaries, force another model turn, introduce per-client counters/curation flags, defer registration speculatively, treat idle eviction as an end, rewrite history, or delete existing empty rows. No installer, dependency, credential or release changes.

## Decisions

### 1. A completed turn is activity, not evidence of tool use or memorability

Apply the same policy to every active session reaching `/turn`, irrespective of client/agent or `usedTools`. Keep the boolean and tool-only monotone `last_work_at` unchanged; do not send `true` just to earn a chat reminder. Unknown-observation fail-open remains unchanged for older clients.

For each incoming active report, derive an ephemeral `activityStartedAt = existing.lastTurnReportAt ?? existing.startedAt` BEFORE advancing the anchor. Pass it explicitly to the pure evaluator under an activity-named input rather than pretending it is `lastWorkAt`. Emit only when:

1. A completed report is being evaluated (an unreported row alone never fires).
2. `lastSummaryAt` is null OR `activityStartedAt > lastSummaryAt` (strict).
3. `now - (lastNudgeAt ?? startedAt) >= NUDGE_FLOOR_MS`.

Retain the exported 25-minute floor, monotone emission stamp, renderer and 640-byte ceiling. No additional timestamp, schema migration, periodic timer or backfill is necessary. Existing timestamp writers remain unchanged. Do not substitute `lastActivityAt` or report arrival for the start anchor: RAW flushes occur after mid-turn curation and must not re-arm that same turn. Equality suppresses. Clock rollback keeps the unclamped previous-report anchor and conservative suppression; tests must account for chat reports now legitimately stamping `lastNudgeAt` earlier in their timelines.

Alternatives rejected: a Hermes-only exception would split shared server policy; falsifying tool use corrupts observations; a second interval or client flag duplicates authority; extra activity columns persist data already available at report time. Conversation-only turns after a curated summary can now re-arm on the next completed turn whose anchor is later, even without tools. This is intentional, not the previous work-only behavior.

### 2. Reuse Hermes delivery unchanged unless regression evidence requires repair

`sync_turn(user, assistant, **kwargs)` already sends RAW `/summary`, then `/turn`, through the context-preserving worker. `prefetch` consumes pending server lines once with session identity and the existing wrapper; it makes no network call. A response arriving after prefetch can appear on a later turn, not necessarily the immediately following turn. Preserve nonempty cache on an empty response, scope bindings, suppression, first-turn opening, resumed read and post-compaction instructions. Do not infer whether curation succeeded from a summary response or keep new local curation state.

Only model-authored MCP `memory.session_summary` writes are curated (`final:true`). Lifecycle RAW writes remain `final:false` and cannot displace curated fields. The notice retains section-wise merge guidance and explicit permission not to call. A one-turn session still depends on opening guidance and/or RAW fallback; the periodic path cannot curate after the last response without another genuine turn.

Alternatives rejected: unconditional every-turn dynamic instructions add noise; synchronous prefetch requests add latency; finalizing RAW text lies about provenance; forced continuation loops are unsafe.

### 3. Treat empty sessions as an unproven, separately gated lifecycle issue

The mock demonstrates that eager registration can create a contentless primary row; it does NOT show which host paths produced the operator's empty rows. Keep initialize ensure/resume before MCP writes. Retain existing non-primary suppression; do not classify all bot-platform primary traffic as subagents, cron or flush work.

Before changing registration or flushing, capture the actual Hermes/gateway and plugin revisions, effective platform/context, session ID across initialize/recreation/switch, completed-turn dispatch, HTTP outcomes and stored row state using synthetic content. Include a real completed-chat control and a suppressed-context control. Distinguish empty summary from RAW fallback and failed/unavailable tool curation. Identify a supported hook with the messages/identity it actually supplies. `shutdown()` has no transcript argument and also runs on soft release; `on_session_end(messages)` is the real-boundary surface, not an idle timer.

A reproduced missing transcript flush can justify a bounded non-final `/summary` on an appropriate supported lifecycle path; it cannot justify ending a continuing ID. A reproduced registration-only path can justify a registration change only after demonstrating first-write attachment and ensure-before-MCP remain correct. If no safe host surface exists, record an upstream limitation and leave lifecycle code unchanged. Obtain a fresh runtime edit authorization for the concrete fix rather than broadening this proposal silently.

Alternatives rejected: lazy registration at first sync occurs after potential MCP writes; blanket bot suppression drops legitimate conversation; `/end` on idle fragments sessions; deleting old rows hides the symptom.

## Risks / Trade-offs

- [Trade-off] All five clients and generic turn reporters gain chat-only eligibility → Accepted because cadence and interpretation already belong to one server; require cross-client delivery regressions and document the blast radius.
- [Risk] A model ignores notices or lacks usable MCP tools → Gateway acceptance must inspect an actual successful curated tool call and stored row; deterministic delivery is not curation success.
- [Risk] Async response misses the next prefetch or the conversation ends → Preserve later delivery and RAW fallback; no forced turn or guarantee of curated closure.
- [Risk] Empty rows come from another deployed version, missing hooks or a different context → No causal claim or lifecycle patch before actual reproduction.
- [Risk] Lost reports or clock rollback suppress useful reminders → Preserve conservative anchoring and test controls; no new timers or stronger signal claims.

## Migration Plan

Implement the authorized server policy and focused regression tests first. No data migration or historical cleanup. Verify HTTP schema/access controls, shared notice bytes and provider delivery. Deploy the server through its normal release track only after required checks; plugin release is needed only if independently justified adapter changes land. Rollback restores tool-conditioned evaluation without touching stored rows or wire compatibility.

## Open Questions

No blocking product choice: default to shared conversational eligibility at the existing floor. Unknown deployed gateway/plugin revisions, actual empty-row cause, hook dispatch and model compliance remain acceptance inputs, not facts to invent. Registration/flush changes remain deferred until the evidence gate is met; this change must not be declared a verified bot-session fix without that evidence.
