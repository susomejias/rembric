## 1. Server: tighten the shared predicate

- [x] 1.1 In `apps/server/src/db/repositories/agent-sessions-repository.ts`, change `sessionHasContentSql`'s clause 1 from `${alias}.summary IS NOT NULL` to `(${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1)`. Leave clauses 2–5 unchanged.
- [x] 1.2 Update/add unit tests in `apps/server/src/db/repositories/agent-sessions-repository.test.ts` (or the relevant service test) covering: a session with only a curated summary satisfies the predicate; a session with only a raw/uncurated summary does NOT satisfy it; a session with an uncurated summary but at least one anchored `memory` row still satisfies it (via clause 3); a session with no content at all fails it.
- [x] 1.3 Confirm `recentForContext` and `countPurgeableEmpty`/`purgeEmpty` require no code changes beyond 1.1 — both already consume `sessionHasContentSql` by reference. Add a regression test asserting a session with only a raw/uncurated summary is excluded from `recentForContext` output.
- [x] 1.4 Add a regression test asserting the same raw/uncurated-summary session IS now counted by `countPurgeableEmpty` / eligible for `purgeEmpty` (previously it was not, since `summary IS NOT NULL` alone used to satisfy the old predicate).
- [x] 1.5 Update the `writeSummary` docstring's caller list in `apps/server/src/services/agent-sessions.ts` (currently names only the MCP tool and the Codex Stop hook; after this change the Claude Stop hook, opencode per-turn flush, and Hermes per-turn sync are callers too — reword to describe the caller classes, not an enumerated list that will drift).

## 2. Server: wire session purge into the consolidation sweep

- [x] 2.1 Locate the consolidation sweep's entry point (the method already invoked, throttled, from `session.start` — decay + deadline orphaning). Add a call to `AgentSessionsService.purgeEmpty` in the same sweep, using the same throttle gate (no new scheduling primitive).
- [x] 2.2 Ensure the purge call journals to `consolidation_ops` identically to the existing manual-trigger path (reuse the same code path, not a parallel one).
- [x] 2.3 Add a test asserting: a noise session (fails `sessionHasContent`, past the age floor) gets purged on the next throttled sweep run, and a `consolidation_ops` row is created.
- [x] 2.4 Add a test asserting the existing manual `/dashboard/maintenance` purge trigger is unaffected (same behavior as before this change).

## 3. Claude Code: new `Stop` hook (pure side effect)

- [x] 3.1 Add `apps/plugin/scripts/stop-sync.sh`: read `session_id`, `cwd`, `transcript_path` from stdin; resolve `PROJECT_SLUG` via `.rembric`; if resolvable and `transcript_path` is readable, format via `rembric_format_transcript_claude_code` and derive title via `rembric_extract_first_assistant_claude_code` (both from the existing `_transcript.sh`); POST `/api/<slug>/sessions/<session_id>/summary` with `{"summary": ..., "title": ...}` — omit `final` entirely (never send `true`). Emit NO stdout under any circumstance. Exit `0` on any error (fail-safe, matching every other hook script).
- [x] 3.2 Wire a `Stop` entry into `apps/plugin/hooks/hooks.json` invoking `stop-sync.sh`, declared with `"async": true`.
- [x] 3.3 Add a test (co-located with the existing hook-script test harness) asserting: `stop-sync.sh` POSTs the expected body shape when transcript+slug resolve; emits no stdout in any case; exits 0 and makes no POST when transcript_path is missing/unreadable or slug doesn't resolve; never includes a `final` key in the POST body.
- [ ] 3.4 **Operator-gated e2e (requires a live Claude Code session against `dev:docker:up`):** verify empirically whether `"async": true` actually decouples the hook's HTTP call from turn completion for the `Stop` event specifically (time the turn with and without a slow/unreachable Rembric server). Record the result in this change's follow-up notes.
- [ ] 3.5 IF task 3.4 shows `async` does NOT reliably decouple latency: implement the throttle fallback — a per-session counter file under `${TMPDIR}/rembric-savenudge/` (or a sibling dir), only POSTing every 3rd matched `Stop` call, mirroring `post-tool.sh`'s existing counter pattern. Add tests for the throttle boundary (no POST on calls 1–2, POST on call 3, counter persists across invocations). Skip this task entirely if 3.4 confirms `async` works.

## 4. opencode: periodic raw sync inside `chat.message`

- [x] 4.1 In `apps/plugin/.opencode-plugin/plugin.ts`, inside the existing `chat.message` handler (after the existing subagent check and accumulation logic), add `void flushSessionSummary(input.sessionID)` — fire-and-forget, not awaited — for every non-subagent call. No throttle, no counter.
- [x] 4.2 Add unit tests to `plugin.test.ts` asserting: `flushSessionSummary` is invoked on every `chat.message` call for a non-subagent session; it is NOT invoked for a subagent session; the handler's own returned promise resolves without waiting on `flushSessionSummary`'s underlying fetch (simulate a slow/hanging fetch and assert the handler still returns promptly).
- [ ] 4.3 **Operator-gated e2e (opencode not installed in this dev environment — same gating pattern as `improve-recall-and-plugin-parity`):** verify against a live opencode session that the per-turn flush actually reaches the server and that turn latency is unaffected.

## 5. Hermes: bump `sync_turn` cadence, make it non-blocking via its documented Threading Contract

- [x] 5.1 In `apps/plugin/.hermes-plugin/__init__.py`, remove the `_SYNC_TURN_HEARTBEAT_EVERY` modulo check from `sync_turn` (or set it to 1) so the sync fires on every call.
- [x] 5.2 Add a `self._sync_thread: threading.Thread | None` instance attribute (initialized in `__init__`). In `sync_turn`, before dispatching: if `self._sync_thread is not None and self._sync_thread.is_alive()`, call `self._sync_thread.join(timeout=5.0)`. Then snapshot the values the POST needs (`base`, `slug`, `session_id`, formatted transcript) into locals, spawn `self._sync_thread = threading.Thread(target=_api_post, args=(...), daemon=True)`, and `.start()` it without joining.
- [x] 5.3 Update/add tests in the Hermes test suite (`apps/plugin/.hermes-plugin/tests/test_prefetch_and_sync_turn.py` or a new file) asserting: `sync_turn` spawns exactly one background thread per call; a second call while the first thread is still alive joins it (with the 5s timeout) before spawning a new one; the calling thread returns without blocking on the spawned thread's completion; the POST body/shape is unchanged from before.
- [x] 5.4 Remove or update any now-stale test asserting the old every-5th-call throttle behavior for `sync_turn`.
- [x] 5.5 In `_format_transcript`, skip messages whose `role` is not `user` or `assistant` (system prompts and tool payloads no longer reach the summary channel). Keep tail-truncation at `_SUMMARY_MAX_CHARS = 20_000` unchanged. This fixes the live bug observed 2026-07-12: an ended Hermes session's summary was dominated by the tail of Hermes's own system prompt. `_derive_title_from_messages` needs no change (already assistant-only).
- [x] 5.6 Add tests: a `messages` list with system+user+assistant roles serializes to user/assistant lines only; a giant system message no longer displaces conversation content from the truncation window; `on_pre_compress`/`on_session_end`/`sync_turn` all inherit the filter (they share `_format_transcript`).

## 6. Dashboard: curation-state honesty on session detail

- [x] 6.1 In `apps/server/src/dashboard/sessions.ts`, render the Summary section conditionally on `row.summaryFinal`: curated → `mdBody(row.summary)` unchanged; uncurated → escaped preformatted monospace block (reuse the existing `<pre>` pattern from judgment Evidence, inside an `overflow-x: auto` container) plus a "RAW" chip adjacent to the Summary heading (existing chip styling — no new design token, no inline `<style>`).
- [x] 6.2 Confirm the admin session-detail read already exposes `summaryFinal` (schema-derived full row); no repository change expected.
- [x] 6.3 Add/update dashboard tests: `summary_final=1` renders Markdown with no RAW chip; `summary_final=0` renders escaped `<pre>` (Markdown NOT interpreted — e.g. a `**bold**` in the raw transcript stays literal) with the RAW chip; description still renders as Markdown in both cases.

## 7. Validation

- [x] 7.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 7.2 `pnpm test` clean (TS + Python), including all new/updated tests from sections 1–6.
- [x] 7.3 `openspec validate --strict close-session-context-pollution-gap` clean.
- [ ] 7.4 Smoke against `pnpm run dev:docker:up` (per the `rembric-smoke-tests` skill): confirm a session ending via `/clear`-equivalent with no curated summary no longer appears in `memory.context.recentSessions`, and confirm it gets purged after crossing the age floor on a subsequent session-start sweep. Visually confirm the RAW chip + preformatted render on an uncurated session's detail page.
- [x] 7.5 **Operator coordination:** confirm the in-progress `proactive-save-nudges` change (16/18 tasks) has landed before starting section 3/4/5 implementation, or rebase this change's plugin-tree diffs against its final state — both changes touch `hooks.json` and `plugin.ts`. Satisfied by construction: `proactive-save-nudges` was implemented first in this same session (its unified per-turn nudge system, incl. the `UserPromptSubmit` entries and `prompt-nudge.sh`, landed before section 3 began), so sections 3/4/5 here were built directly on top of its final state — no rebase needed.
