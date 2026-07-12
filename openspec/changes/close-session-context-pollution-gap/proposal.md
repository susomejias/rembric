## Why

`sessionHasContentSql` — the gate deciding which sessions surface in `memory.context.recentSessions` (`apps/server/src/db/repositories/agent-sessions-repository.ts:71-79`) — accepts any `summary IS NOT NULL`, without requiring curation (`summary_final=1`). Claude Code's `session-end.sh` falls back to dumping the raw transcript JSONL as `summary` whenever the agent never called `memory.session_summary`, so framework noise (e.g. the `<local-command-caveat>` wrapper Claude Code injects around `/clear`) reaches `memory.context` for every future session. Verified live: a 2026-07-08 session carrying exactly that garbage text resurfaced as a `recentSession` when a later conversation started.

(Considered and declined during exploration: hardening the HTTP `/summary`/`/end` endpoints to always force `final: false`, closing the theoretical possibility that an HTTP writer could claim `final:true`. Rejected — that capability is tested, documented, ratified behavior (`http-api/spec.md:89-93`, exercised by `api-router.test.ts:216`), and closing it wouldn't actually raise the security bar: anyone holding a valid bearer token for the HTTP endpoint already holds the same token for MCP, where `memory.session_summary` lets them achieve the identical "curated" outcome legitimately. No current script sends `final:true` over HTTP anyway, so the predicate fix below is fully effective without touching this endpoint.)

A complete fix for the gate (predicate split + HTTP hardening + auto-curate) was designed and even implemented on the orphaned branch `feat/tighten-context-final-summaries` (commit `e626a59`, May 2026), but it was never merged to `main` and has since diverged past the point of rescue (704 files, forked before the monorepo restructure). It serves only as design reference. The Rembric memory documenting it as "shipped" is stale and will be corrected separately.

This change closes the gap with a minimal, zero-LLM-token-cost design: a hardened predicate that only trusts genuinely curated content, an automatic cleanup of empty "noise" sessions, and parity raw-transcript syncing across clients that don't yet have it — with no model-facing nudging added anywhere.

## What Changes

- **Predicate tightening, not forking**: the existing single shared predicate `sessionHasContent` (used by both `recentForContext` and `purgeEmpty`/`countPurgeableEmpty`) has its `summary IS NOT NULL` clause tightened to `summary IS NOT NULL AND summary_final = 1` — matching the same curation requirement its `title_final = 1` clause already enforces. One clause, one place, both consumers fixed at once: raw-transcript-only sessions stop surfacing in `memory.context.recentSessions` AND become purge-eligible (no separate predicate, no regression for sessions with real anchored memories/prompts/confirmations but no curated summary — those still count as "has content" via the unchanged EXISTS clauses).
- **Automatic empty-session purge**: `purgeEmpty` (already implemented, currently triggered only manually from `/dashboard/maintenance`) is additionally invoked from the existing deterministic consolidation sweep (already running throttled on `session.start`, no LLM, no cron).
- **Claude Code — new `Stop` hook, pure side-effect**: reuses the existing `rembric_format_transcript_claude_code`/`rembric_extract_first_assistant_claude_code` parsers to POST summary+title to `/sessions/:id/summary` with `final:false`, never emitting `hookSpecificOutput.additionalContext` or any other model-facing output. Declared with `"async": true` if validated to actually decouple latency during this change's e2e pass; falls back to a per-session throttle counter (mirroring `post-tool.sh`'s pattern) if `async` doesn't reliably decouple it. This is a **MODIFIED** requirement against the currently-ratified `claude-code-plugin` spec line stating "the prior Stop and PreCompact entries SHALL NOT be wired in this version" — distinguishing the historical semantic bug (the old Stop hook posted to `/end`, terminating the session on turn 1 because Stop fires per-turn, not per-session) from this new usage (posts only to `/summary`, never `/end`, never touches the model — matching the spec's own pre-existing token-budget line "Stop hook output: 0 tokens to model (side effect)").
- **opencode — periodic raw sync**: reuse the existing `flushSessionSummary` function inside the already-per-turn `chat.message` handler, fire-and-forget (`void flushSessionSummary(...)`, the same non-blocking pattern already shipping today via `scheduleIdleFlush`). Currently opencode only flushes on `session.compacted`/dispose, not per-turn.
- **Hermes — bump cadence to every turn, made non-blocking, and serialize only the conversation**: `sync_turn`'s heartbeat (`_SYNC_TURN_HEARTBEAT_EVERY`, currently 5) drops to 1 (every turn), matching the other three clients. Made safe by moving the `_api_post` call onto a background, join-bounded `threading.Thread` per Hermes's documented Threading Contract — Hermes's provider runs in-process, so unlike Codex this is a real drop-in fix, not a wish. Additionally, `_format_transcript` now filters to `user`/`assistant` roles only: today it serializes every message _including `role: system`_, so a short session's tail-truncated summary ends up dominated by Hermes's giant system prompt (verified live on an ended session, 2026-07-12) — the Claude/Codex parsers already filter strictly to user/assistant; this brings Hermes to parity and makes its raw summaries actual conversation transcripts.
- **No changes to Codex CLI** — already syncs every turn via `session-stop.sh`; confirmed against Codex's own docs that no async/non-blocking hook mode exists to make it non-blocking, so there is nothing to add here.
- **Dashboard — curation-state honesty on session detail**: an uncurated summary (`summary_final = 0`) renders as escaped preformatted text with a "RAW" chip next to the Summary heading, instead of today's unconditional Markdown render that makes a raw transcript dump visually indistinguishable from a model-authored summary (observed misleading the operator in practice). Curated summaries keep the Markdown render unchanged. Existing chip styling, no new design token.

Explicitly out of scope: any model-facing nudge asking an agent to call `memory.session_summary`, on any client. Evaluated and declined during exploration — the same "forced-continuation risk" reasoning that led the in-progress `proactive-save-nudges` change to reject a Claude `Stop`-based nudge for `memory.save` applies equally here, and the predicate split alone already fully prevents uncurated content from reaching `memory.context` without needing curated content to exist.

## Capabilities

### New Capabilities

(none — this change modifies existing capabilities only)

### Modified Capabilities

- `sessions`: tightens the `sessionHasContent` predicate's summary clause to require curation (`summary_final=1`), and wires `purgeEmpty` into the consolidation sweep.
- `claude-code-plugin`: revises the "Stop and PreCompact entries SHALL NOT be wired" requirement to permit a side-effect-only `Stop` hook for summary/title syncing (still prohibiting any model-facing Stop output).
- `opencode-plugin`: adds a periodic raw summary sync inside the existing `chat.message` handler.
- `hermes-agent-plugin`: bumps `sync_turn` cadence to every turn, moves its HTTP call off the blocking path onto a background thread, and filters `_format_transcript` to conversational roles (user/assistant) so system prompts and tool payloads never reach the summary channel.
- `consolidation`: the sweep additionally invokes session purge, not just decay/orphaning.
- `dashboard`: uncurated session summaries render as raw preformatted text with a RAW badge; only curated summaries are Markdown-rendered.

## Impact

- `apps/server/src/db/repositories/agent-sessions-repository.ts` — tighten `sessionHasContentSql`'s summary clause to require `summary_final = 1`; `recentForContext` and `purgeEmpty`/`countPurgeableEmpty` both inherit the fix automatically since they already consume the same shared predicate.
- `apps/server/src/services/agent-sessions.ts` and/or `apps/server/src/consolidation/*` — wire `purgeEmpty` into the existing sweep.
- `apps/plugin/hooks/hooks.json` — new `Stop` entry.
- `apps/plugin/scripts/` — new script (name TBD in design, e.g. `stop-sync.sh`) reusing `_transcript.sh` parsers, plus a throttle-counter fallback path if `async` doesn't hold up.
- `apps/plugin/.opencode-plugin/plugin.ts` — periodic `flushSessionSummary` call from `chat.message`.
- `apps/plugin/.hermes-plugin/__init__.py` — `_SYNC_TURN_HEARTBEAT_EVERY` 5→1; `sync_turn`'s `_api_post` call moves onto a background, join-bounded `threading.Thread`; `_format_transcript` skips messages whose role is not `user`/`assistant`.
- `apps/server/src/dashboard/sessions.ts` (+ `apps/server/src/dashboard/styles/` if the chip needs a variant) — conditional summary rendering by `summaryFinal`.
- `openspec/specs/{sessions,claude-code-plugin,opencode-plugin,hermes-agent-plugin,consolidation,dashboard}/spec.md` — requirement deltas.
- No changes to `apps/server/src/server/api-router.ts`, `apps/plugin/hooks/hooks.codex.json`, or the `http-api` spec — both considered and declined (see Why).
- Coordinate with the in-progress `proactive-save-nudges` change (16/18 tasks done) on any overlapping edits to `hooks.json` / `plugin.ts` — different change, complementary (nudges vs. raw sync + gate), not conflicting.
