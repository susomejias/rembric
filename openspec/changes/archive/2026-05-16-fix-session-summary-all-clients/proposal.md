## Why

Every recent session in `/dashboard/sessions` has `summary: null` (confirmed via `memory.context` — 5 of 5 most recent rows). The plugin's `pre-compact.sh` POSTs hook metadata (`{session_id, transcript_path, hook_event_name, trigger}`) instead of the actual transcript, and Claude Code's `Stop` hook is wired where `SessionEnd` belongs, so every session ends with no summary regardless of length. There is no `title` field at all — the dashboard list shows only an opaque short id. Operators cannot tell what any past session was about.

## What Changes

- **BREAKING (HTTP API)**: `POST /api/<slug>/sessions/<id>/summary` no longer transitions status — it writes summary/title only. `POST /api/<slug>/sessions/<id>/end` becomes the sole transition. Both endpoints accept `{summary?, title?, final?: boolean}`.
- **BREAKING (MCP)**: `memory.session_summary` accepts `{summary, title?}` (title optional, backwards-compat for callers that omit it). The tool no longer ends the session — `memory.session_end` is the single transition point.
- **Schema**: new `sessions.title TEXT` nullable column. Migration is additive.
- **Write-once policy**: summary and title writes carry an implicit or explicit `final` flag. A `final:true` write locks the value; subsequent non-final writes are ignored. Non-final writes can overwrite earlier non-final writes. Model-authored writes (via `memory.session_summary`) are always `final:true`; bash/Python fallbacks always `final:false`.
- **Plugin Claude Code**:
  - **REMOVE** `Stop` hook from `hooks.json` (was the per-turn bug: `Stop` fires after every assistant turn, not at session end).
  - **REMOVE** `pre-compact.sh` (its stdout never reached the model — verified against `code.claude.com/docs/en/hooks` — and its POST body was garbage JSON metadata).
  - **NEW** `SessionStart` hook with `matcher: "compact"` → new `post-compact.sh` that prints an imperative protocol instruction to stdout. SessionStart is one of the three events whose stdout IS injected into Claude's context (verified). This is the engram pattern (`Gentleman-Programming/engram` upstream).
  - **NEW** `SessionEnd` hook → new `session-end.sh` that reads `transcript_path`, formats it, and POSTs `/end {summary, title, final:false}`.
- **Plugin Codex CLI** (forced divergence — Codex has no `SessionEnd`, no `PreCompact`/`PostCompact`, no `compact` source on `SessionStart`):
  - `Stop` hook becomes the only summary-write path. `session-stop.sh` POSTs `/summary {transcript, title, final:false}` on every turn (keeps status `active`) and emits `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs). Codex sessions stay `active` until `abandonStale` flips them.
- **Plugin Hermes Agent**:
  - `on_session_end(messages)` POSTs `/end {summary: _format_transcript(messages), title, final:false}` instead of `/end {}`.
  - **NEW** `on_session_switch(new_session_id, parent_session_id)` override — closes the old session and registers the new one. Fixes a latent bug where compression rotates `session_id` and our provider silently keeps writing to the dead one.
  - `system_prompt_block()` emits the same protocol nudge that Claude/Codex agents get via `initialize.instructions`.
- **MCP `initialize.instructions`**: append a permanent protocol nudge: "Before saying 'done', call `memory.session_summary` with `{title, summary}`. Title ≤100 chars describing what was actually worked on. Summary: Goal · Discoveries · Accomplished · Next Steps · Files."
- **Dashboard**:
  - Session list adds a `title` column rendered as `row.title ?? row.description ?? shortId(row.id)`.
  - Session detail page `<h1>` renders the title instead of `Rembric Session <shortId>`.
- **Initial title at SessionStart**: server writes a placeholder `basename(cwd) · HH:MM UTC`. Honest, recognisable as provisional, overwritten by any later non-placeholder write.
- **Version bumps** in all three manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) — minor (e.g. `0.4.0` → `0.5.0`) — plus `plugin/CHANGELOG.md` entry.

## Capabilities

### New Capabilities

- `plugin-session-protocol`: formalises the cross-client write-priority cascade (model > Hermes direct > bash fallback > placeholder), the `final:boolean` flag semantics, and the per-client mapping of lifecycle events to HTTP endpoints. This contract is what keeps Claude Code, Codex, and Hermes interchangeable from the server's point of view despite their divergent hook surfaces.

### Modified Capabilities

- `sessions`: summary/title write-once policy; `summarize()` no longer transitions to `ended`; `end()` becomes the sole transition and accepts optional `{summary, title, final}`; new `title` column.
- `http-api`: `POST /sessions/<id>/summary` body shape changes (`{summary, title?, final?}`); `POST /sessions/<id>/end` body shape changes (`{summary?, title?, final?}`); summary endpoint no longer ends the session.
- `mcp-api`: `memory.session_summary` accepts `{summary, title?}`; tool no longer transitions to `ended`; `initialize.instructions` includes the new permanent protocol nudge.
- `dashboard`: session list shows `title` column; session detail renders title in `<h1>`; both use the derived-fallback cascade for missing values.
- `claude-code-plugin`: hooks.json reshape (remove `Stop`, remove `pre-compact.sh`, add `SessionStart matcher:"compact"`, add `SessionEnd`); new `post-compact.sh` and `session-end.sh` scripts; `session-stop.sh` and `pre-compact.sh` deleted.
- `codex-distribution`: hooks.codex.json keeps `Stop` (only available end-signal); `session-stop.sh` becomes the per-turn `/summary` writer and emits required JSON to stdout.
- `hermes-agent-plugin`: `on_session_end` posts summary; new `on_session_switch` override; `system_prompt_block` non-empty.

## Impact

- **Code**: `src/server/api-router.ts`, `src/services/agent-sessions.ts`, `src/db/schema/agent-sessions.ts`, `src/db/migrations/` (new migration for `title` column), `src/mcp/sessions-tools.ts`, `src/mcp/instructions.ts`, `src/dashboard/sessions.ts`, `plugin/hooks/hooks.json`, `plugin/hooks/hooks.codex.json`, `plugin/scripts/_api.sh` (new helper `_transcript.sh`), `plugin/scripts/session-end.sh` (new), `plugin/scripts/post-compact.sh` (new), `plugin/scripts/session-stop.sh` (Codex-only behaviour), DELETE `plugin/scripts/pre-compact.sh`, `plugin/.hermes-plugin/__init__.py`, all three `plugin/.{claude,codex,hermes}-plugin/plugin.{json,yaml}` manifests, `plugin/CHANGELOG.md`.
- **HTTP API contract**: external callers POSTing to `/summary` or `/end` must accept the extended body and the changed status semantics. The plugin clients are the only known callers; both are updated in this change.
- **MCP tool surface**: `memory.session_summary` callers that pass only `{summary: string}` keep working (title optional). Callers that depended on the side-effect of `summarize()` ending the session must explicitly call `memory.session_end` (no known callers in the wild — verified via grep).
- **Dependencies**: none added.
- **Migration**: append-only — adds `title TEXT` nullable column. Existing rows get `title=null` and fall through the dashboard cascade to `description` or `shortId`. No backfill.
- **Tests**: invariant tests under `src/**/__tests__/invariants/` and the per-module `*.test.ts` files for sessions, MCP tools, API router, dashboard, and Hermes provider all need updates to reflect the new write-once policy and event split.
