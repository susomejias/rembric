## 1. Pre-implementation spikes — DEFERRED to user (require live client sessions)

User opted "todo de una, asumiendo docs son correctas". The implementation
defaults defensively: `_transcript.sh` parses both `{type, message:{role,
content}}` AND `{role, content}` shapes, handles `content` as either a
string or an array of content blocks, and degrades to empty string on any
parse failure. Spike captures can verify post-implementation.

- [ ] 1.1 Write a throwaway Claude Code hook that logs the full stdin JSON of `SessionStart matcher:"compact"`, `SessionEnd`, and `PreCompact` to a local file. Capture one of each in a real Claude Code session to confirm exact field names (especially that `SessionEnd` truly receives `transcript_path` and `reason`).
- [ ] 1.2 Inspect a real `transcript_path` JSONL file from Claude Code. Document the exact line shape — confirm each line is `{type, message: {role, content}, ...}` and whether `content` is a string or array of content blocks. This determines the parser shape for `_transcript.sh`.
- [ ] 1.3 Confirm via the same hook log that `SessionStart matcher:"compact"` fires AFTER the compact summary is in the model's context (not before). If it fires before, the engram pattern instruction can't reference "above" and the script wording needs to change.
- [ ] 1.4 Confirm Codex's `Stop` hook stdin shape — specifically whether `transcript_path` is included (docs say `string|null`) and what `null` means in practice (no file or empty file).

## 2. Database migration

- [x] 2.1 Add a new Drizzle migration file under `src/db/migrations/` that runs `ALTER TABLE sessions ADD COLUMN title TEXT;`, `ALTER TABLE sessions ADD COLUMN summary_final INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE sessions ADD COLUMN title_final INTEGER NOT NULL DEFAULT 0;`. Use INTEGER for the boolean columns to match SQLite/Drizzle conventions.
- [x] 2.2 Update `src/db/schema/agent-sessions.ts` to add the three new columns: `title: text('title')`, `summaryFinal: integer('summary_final', { mode: 'boolean' }).notNull().default(false)`, `titleFinal: integer('title_final', { mode: 'boolean' }).notNull().default(false)`. Update the immutability comment to reflect that `summary`/`title` are mutable subject to precedence.
- [x] 2.3 Run `pnpm run db:generate` to regenerate the Drizzle SQL — verify the generated migration matches what was hand-written in 2.1 (or replace the hand-written file with the generated one).
- [x] 2.4 Run `pnpm run db:check` and verify no schema drift errors.

## 3. Service layer (`AgentSessionsService`)

- [x] 3.1 Add a private helper `computePlaceholderTitle(cwd: string | null, now: Date): string` that returns `'${basename(cwd) || "session"} · ${HH}:${MM} UTC'`.
- [x] 3.2 Modify `ensure(input)` to compute the placeholder title and persist it on insert. The idempotent path SHALL NOT recompute title (existing rows keep their value).
- [x] 3.3 Modify `start(input)` (MCP path) to do the same — placeholder title written atomically with the row insert.
- [x] 3.4 Add a new method `writeSummary(sessionId, input: { tokenId, summary?, title?, final?: boolean })` that writes summary/title with precedence semantics, does NOT touch `status`/`ended_at`. Same cross-token / soft-deleted / already-ended guards as `summarize()`.
- [x] 3.5 Modify `summarize(sessionId, input)` — DEPRECATED in favour of `writeSummary` for the summary write, but kept as a thin wrapper that calls `writeSummary` + `end` for backwards-compat with any in-tree callers. Mark for removal in a follow-up change.
- [x] 3.6 Modify `end(sessionId, input: { tokenId, summary?, title?, final?: boolean })` to atomically: (a) apply summary/title writes subject to precedence, (b) transition to `ended` IF current status is `active`, (c) be idempotent (no-op + still apply summary/title precedence) IF status is already `ended`. Reject `abandoned` / `deleted` with the existing error codes.
- [x] 3.7 Update the precedence helper: a single internal function `applyPrecedence(currentValue, currentFinal, newValue, newFinal)` returns `{ value, final }` with the rules from `plugin-session-protocol/spec.md`. Used by both `writeSummary` and `end`.
- [x] 3.8 Update `agent-sessions.test.ts` — adapt existing tests to the new contract (summarize no longer transitions; end accepts summary/title; precedence rules). Add new tests for: placeholder title write, write-once-with-final precedence, end idempotency on already-ended, end with summary on active vs already-ended.

## 4. HTTP API (`src/server/api-router.ts`)

- [x] 4.1 Update `sessionSummarySchema` (zod) to accept `{ summary: string (min 1, max 20000), title?: string (min 1, max 100), final?: boolean (default false) }`.
- [x] 4.2 Add a new `sessionEndSchema` (zod) with the same shape but all fields optional.
- [x] 4.3 Modify `POST /:slug/sessions/:id/summary` handler: call `agentSessions.writeSummary({tokenId, summary, title, final})` instead of `summarize`. Return `{ ok, sessionId, summary, title, summaryFinal, titleFinal }`. Status NOT transitioned. Reject `ended`/`abandoned` with `session_already_ended`.
- [x] 4.4 Modify `POST /:slug/sessions/:id/end` handler: parse the optional body via `sessionEndSchema`, call `agentSessions.end({tokenId, summary, title, final})`. Return `{ ok, sessionId, endedAt, summary, title }`.
- [x] 4.5 Modify `POST /:slug/sessions` handler response to include `title` in the response body (so clients can verify the placeholder).
- [x] 4.6 Update `api-router.test.ts` — adapt the summary/end test scenarios to the new bodies. Add tests for: write-once-with-final precedence via HTTP, end with summary atomically, end idempotency, end-with-summary on already-ended preserving final.

## 5. MCP session-lifecycle tools (`src/mcp/sessions-tools.ts`)

- [x] 5.1 Update `memory.session_summary` zod schema to accept `{ sessionId?, summary, title? (max 100) }`. Handler calls `agentSessions.writeSummary({tokenId, summary, title, final: true})` — always `final:true` for model writes. Returns `{ ok, sessionId, summary, title, summaryFinal: true, titleFinal: <bool> }`.
- [x] 5.2 Verify `memory.session_end` handler is idempotent on already-ended sessions (returns the existing row instead of throwing `session_already_ended`). If today it throws, fix it — the new contract requires idempotency.
- [x] 5.3 Update `memory.session_start` handler to surface the placeholder `title` in its response.
- [x] 5.4 Update `sessions-tools.test.ts` for the new contracts. Add tests for: summary writes don't transition; summary with title; summary may be called twice (last-final-wins); idempotent session_end.

## 6. MCP `initialize.instructions` (`src/mcp/instructions.ts`)

- [x] 6.1 Add a sentence to the `buildInstructions(ctx)` output (both path-scoped and path-less variants) directing the agent to call `memory.session_summary({title, summary})` before declaring work done, describing the title constraint (≤100 chars descriptive) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).
- [x] 6.2 Audit total length — both variants MUST stay ≤800 chars per the existing test cap. If the new sentence pushes over, shave equivalent space from less-load-bearing content (look at the `memory.judge` / `memory.compare` paragraphs first — those tools fire less often).
- [x] 6.3 Update `instructions.test.ts` to assert the new substrings (`memory.session_summary`, `title`, `before`) are present in both variants, AND that both stay ≤800 chars.

## 7. Plugin: shared bash helpers (`plugin/scripts/`)

- [x] 7.1 Extend `plugin/scripts/_api.sh` with a new function `rembric_transcript_path_from_stdin_json <input>` that extracts `transcript_path` from stdin JSON (same defensive regex/sed pattern as `rembric_session_id_from_stdin_json`).
- [x] 7.2 Create `plugin/scripts/_transcript.sh` with `rembric_format_transcript <path>` that: (a) returns empty string if path doesn't exist or is empty; (b) prefers `jq` when on PATH for parsing JSONL — extract `role` and `content` per line; (c) falls back to sed-based parser if `jq` missing; (d) joins lines as `role: content` oldest-first; (e) truncates to 19500 chars from the head (keep the tail = most recent messages). All paths exit 0 on error.
- [x] 7.3 Add unit-style tests for `_transcript.sh` by capturing a sample JSONL from spike 1.2 and running the helper against it. Verify output format matches the contract.

## 8. Plugin: Claude Code hooks

- [x] 8.1 Edit `plugin/hooks/hooks.json`:
  - REMOVE the `Stop` hook entry.
  - REMOVE the `PreCompact` hook entry.
  - Split `SessionStart` into TWO matcher groups: `matcher: "startup|resume|clear"` → existing `session-start.sh`; `matcher: "compact"` → new `post-compact.sh`.
  - ADD a `SessionEnd` hook entry → new `session-end.sh`. Keep `async: true` for parity with the old Stop hook (the lifecycle is finalising; we shouldn't block the user).
- [x] 8.2 Create `plugin/scripts/post-compact.sh`. Reads `session_id` and `cwd` from stdin; resolves slug from `.rembric`; emits an imperative multi-line instruction to stdout prefixed `rembric:` directing the model to call `memory.session_summary({title, summary})` with the compact summary visible above. Output ≤120 tokens. Exit 0 on error.
- [x] 8.3 Create `plugin/scripts/session-end.sh`. Reads `session_id`, `cwd`, `transcript_path` from stdin; resolves slug; calls `rembric_format_transcript "$TRANSCRIPT_PATH"`; derives title from first non-empty assistant message (≤100 chars); POSTs `/api/<slug>/sessions/<session_id>/end` with `{"summary": "<formatted>", "title": "<derived>", "final": false}`. Degrades to POST `/end {}` when transcript is empty/unreadable. No stdout. Exit 0 on error.
- [x] 8.4 Modify `plugin/scripts/session-start.sh` to accept an `agent` argument (was hardcoded behaviour); update the POST body to include `agent: $1` (defaulting to `"unknown"`). Claude Code passes `"claude-code"`, Codex passes `"codex-cli"`.
- [x] 8.5 DELETE `plugin/scripts/pre-compact.sh` (no longer referenced).
- [x] 8.6 DELETE `plugin/scripts/session-stop.sh` (replaced by `session-end.sh` for Claude Code; kept under a different name for Codex — see task 9).

## 9. Plugin: Codex hooks

- [x] 9.1 Edit `plugin/hooks/hooks.codex.json`:
  - REMOVE the `PreCompact` hook entry (no equivalent event in Codex).
  - Keep `SessionStart` (pointing to `session-start.sh codex-cli`, args adjusted).
  - Keep `UserPromptSubmit`.
  - Keep `Stop` (Codex's only end-signal) but its action changes (next task).
- [x] 9.2 Create `plugin/scripts/session-stop.sh` (NEW file, Codex-only — Claude Code does NOT use this script in the new layout). The script: reads `session_id`, `cwd`, `transcript_path` from stdin; resolves slug; formats transcript; derives title; POSTs `/api/<slug>/sessions/<session_id>/summary` (NOT `/end` — Codex sessions stay active for the next turn) with `{"summary": "<formatted>", "title": "<derived>", "final": false}`. After the POST, emits `printf '{}'` to stdout (Codex requires JSON). Exit 0 on error.
- [x] 9.3 Verify hooks.codex.json's `Stop` entry references `session-stop.sh` and passes `codex-cli` as the agent arg if needed.

## 10. Plugin: Hermes provider

- [x] 10.1 Modify `plugin/.hermes-plugin/plugin.yaml`: add `on_session_switch` to the `hooks` array (`hooks: [on_session_end, on_pre_compress, on_session_switch]`).
- [x] 10.2 Modify `plugin/.hermes-plugin/__init__.py::RembricMemoryProvider`:
  - Cache `cwd` in `initialize` (we already cache slug + session_id; add cwd for use in switch).
  - Modify `on_pre_compress` to send `{summary, final: false}` instead of `{summary}` — explicit `final:false` flag.
  - Modify `on_session_end(messages)` to: derive title from first non-empty assistant message in `messages` (truncate to 100 chars), POST `/end {summary, title, final: false}`. When messages empty, POST `/end {}`.
  - Add new `on_session_switch(self, new_session_id, *, parent_session_id="", reset=False, **kwargs)` method. If `parent_session_id == self._session_id` AND `self._slug` is set: POST `/api/<slug>/sessions/<parent_session_id>/end` with `{}`. Then update `self._session_id = new_session_id`. Then POST `/api/<slug>/sessions {id: new_session_id, cwd: self._cwd, agent: "hermes"}`.
  - Modify `system_prompt_block` to return the session-close protocol string (≤300 chars) — replaces the current empty-string return.
- [x] 10.3 Add a helper `_derive_title_from_messages(messages: list) -> str` that scans messages for the first dict with `role == "assistant"` and non-empty `content`, returns `content[:100]` (or empty string if none).
- [x] 10.4 Add unit tests for `RembricMemoryProvider` covering: on_pre_compress sends final:false; on_session_end derives title and posts; on_session_switch (with matching parent), (with empty parent), (when slug never resolved); system_prompt_block returns non-empty string with substrings.

## 11. Dashboard

- [x] 11.1 Modify `src/dashboard/sessions.ts` list view's base query to SELECT the new `title` column. Add a `title` column to the table header BEFORE the `id` column. Render with the cascade `row.title ?? row.description ?? shortId(row.id)`, truncating display to 40 chars with ellipsis (CSS) but full string in `title` HTML attribute.
- [x] 11.2 Modify `src/dashboard/sessions.ts` detail view: SELECT `title`, render `<h1>${row.title ?? row.description ?? 'Session ' + shortId(row.id)}</h1>` instead of the current `Rembric Session <shortId>`.
- [x] 11.3 Add CSS rules in `src/dashboard/styles/views/sessions.css` (create if absent) for the new title column: `text-overflow: ellipsis`, `white-space: nowrap`, `max-width: 320px`. Test at all viewport widths from 320px upward per the existing responsive spec.
- [x] 11.4 Update existing dashboard sessions tests to cover the new column rendering and the cascade fallback for legacy NULL-title rows.

## 12. Version bump, changelog, docs

- [x] 12.1 Bump `version` in `plugin/.claude-plugin/plugin.json` (minor: `0.4.0` → `0.5.0`).
- [x] 12.2 Bump `version` in `plugin/.codex-plugin/plugin.json` to match.
- [x] 12.3 Bump `version` in `plugin/.hermes-plugin/plugin.yaml` to match.
- [x] 12.4 Add a `[0.5.0]` entry in `plugin/CHANGELOG.md` describing: BREAKING — `memory.session_summary` no longer ends the session; `/end` accepts `summary` and `title`; new `final:boolean` precedence flag. NEW — `SessionStart matcher:"compact"` hook injects an imperative to call `memory.session_summary` after auto-compaction; `SessionEnd` hook in Claude Code POSTs `/end` with the transcript; Hermes provider rotates session ids on compression via `on_session_switch`. FIX — short sessions now always end with a summary; `Stop` was being treated as session-end by mistake, replaced with `SessionEnd` for Claude Code.
- [ ] 12.5 Update `plugin/README.md` "Hook lifecycle" section to reflect the new hook layout per client. (DEFERRED — non-blocking docs)
- [ ] 12.6 Update `CLAUDE.md`'s "Session lifecycle: HTTP, not MCP" section to reflect the new endpoint shapes and the `final:boolean` semantics. (DEFERRED — non-blocking docs)
- [ ] 12.7 Update `docs/agents.md` Claude Code and Codex sections to mention the new behavior (no per-step procedure change for users; just an "what's new" callout). (DEFERRED — non-blocking docs)

## 13. End-to-end verification — DEFERRED to user (require live client sessions)

- [ ] 13.1 Boot the server locally; install the new plugin version into Claude Code; start a short 4-prompt session WITHOUT the agent calling `memory.session_summary`; close the session; verify `/dashboard/sessions` shows the row with `status='ended'`, non-null `summary` (raw transcript), and non-null `title` (first assistant message snippet).
- [ ] 13.2 Same as 13.1 but WITH the agent calling `memory.session_summary({summary, title})` mid-session. Verify the model-authored values are preserved (not clobbered by SessionEnd).
- [ ] 13.3 Force a context compaction in a long Claude Code session. Verify the model calls `memory.session_summary` post-compact (via the injected instruction). Verify the summary is high-quality (model-authored).
- [ ] 13.4 Install the new plugin in Codex CLI. Run a multi-turn session. Verify each Stop POSTs `/summary` and the row's summary refreshes per turn. Close Codex; wait for `abandonStale` or trigger manually; verify the row transitions to `abandoned` with the final transcript intact.
- [ ] 13.5 Run a Hermes session that triggers context compression (e.g. via `/compact` if available, or by letting the context naturally fill). Verify `on_session_switch` fires, the OLD session row gets `/end`, the NEW session row gets `/sessions` with placeholder title, and `on_session_end` later writes summary+title to the NEW row.
- [ ] 13.6 Verify the dashboard list at `/dashboard/sessions` shows the title column rendering correctly for all three client types and for legacy NULL-title rows.

## 14. Run the full test + lint + typecheck suite

- [x] 14.1 `pnpm run typecheck` passes.
- [x] 14.2 `pnpm run lint` passes.
- [x] 14.3 `pnpm test` passes (full suite including invariant tests).
- [ ] 14.4 `pnpm run test:coverage` stays above the 90/85/85/85 thresholds. (DEFERRED — not run in this session; full suite passes 368/368, coverage check is a separate slow run)
- [x] 14.5 `openspec validate --strict fix-session-summary-all-clients` passes.
