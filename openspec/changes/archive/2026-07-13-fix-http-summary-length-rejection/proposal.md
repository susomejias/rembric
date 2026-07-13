## Why

Hermes sessions (and potentially any client) end up with an **empty raw transcript** because `POST /api/<slug>/sessions/:id/summary` rejects the raw-sync body with `400 invalid_input` instead of truncating it — the exact opposite of that endpoint's documented contract. Root cause, confirmed with certainty: the plugin truncates the transcript by **Unicode code points** (`len()` in Python, cap 20 000), but the server's zod `summary: z.string().max(20_000)` counts **UTF-16 code units** (`.length` in JS). A transcript of ≤20 000 code points that contains characters outside the BMP (emoji — which Hermes uses heavily) measures **>20 000 UTF-16 units**, so it trips the zod "wire DoS guard" and is rejected **before** the handler's `truncateSummary` ever runs. Reproduced in isolation: `z.string().max(20_000)` on `'a'.repeat(19999) + '😀'` (20 000 code points, 20 001 UTF-16) → rejected with `"String must contain at most 20000 character(s)"`. Confirmed in the user's production logs (Matrix gateway): `POST /sessions/<id>/summary failed: HTTP Error 400` on every turn of affected conversations, while `on_turn_start` always logs the correct session id (ruling out session routing).

This contradicts the endpoint's own contract: `api-router.ts` comments _"HTTP path truncates server-side… writers cannot react to invalid_input"_, and `plugin-session-protocol` states _"The server SHALL truncate any body whose summary.length exceeds SUMMARY_MAX_CHARS."_ The raw-sync HTTP path must **never** reject by length — it must truncate. The wire cap (20 000) being the _same number_ as the plugins' code-point truncation, with zero margin for the unit mismatch, is what breaks the guarantee. The `title` field (zod `max(100)`, also UTF-16, and **not** truncated server-side) has the same latent defect.

## What Changes

- **The HTTP raw-sync path (`/summary`, `/end`) SHALL NOT return `invalid_input` for an over-length `summary` or `title`** — it SHALL truncate to the effective service cap and return `200 OK`, honoring the documented "truncate, don't reject" contract for non-interactive writers. The wire-level DoS guard stays, but with enough margin that a plugin which truncated to its own code-point cap can never trip it via the code-point↔UTF-16 mismatch. (Design evaluates: raise the zod `max` to a margin ≥ the worst-case 2× expansion, vs. drop the char-count `max` and rely on `truncateSummary` + a transport body-size limit.)
- **`title` on the HTTP path SHALL be truncated server-side** (a `truncateTitle` counterpart to `truncateSummary`) rather than rejected, closing the same mismatch for the derived title.
- **The MCP path (`memory.session_summary`) keeps rejecting** over-length input — that caller (the agent) _can_ react and retry.
- **Plugin logging improvement** (operator-requested): the Hermes `_api_request` (and, with parity, the other clients where blind) SHALL log the HTTP error **body** (`{code, message}` — not conversation content) on failure, so a future `invalid_input` is diagnosable from `journalctl` without hand-instrumenting production.

Not addressed here (already ruled out as causes): session-id routing / `self._session_id`, the `fix-cross-session-misattribution` change, nudge cadence.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `http-api`: `POST /sessions/:id/summary` and `/sessions/:id/end` change their length-validation contract — over-length `summary`/`title` are truncated server-side (200 OK), not rejected (400); the wire DoS guard is re-expressed with margin over the plugins' code-point truncation so the unit mismatch can't trip it.
- `plugin-session-protocol`: the "server SHALL truncate any body whose summary.length exceeds SUMMARY_MAX_CHARS" guarantee is made effective by removing the code-point↔UTF-16 cliff that let a compliant plugin body still be rejected.

The plugin-side error-body logging is an internal diagnostics improvement (it does not change any provider method's contract), so it needs no delta spec — it lands as an implementation task with client parity.

## Impact

- **Server:** `apps/server/src/server/api-router.ts` (`sessionSummarySchema`/`sessionEndSchema` caps; `/summary` and `/end` handlers apply title truncation), `apps/server/src/services/agent-sessions.ts` (`truncateSummary` sibling for title, or shared helper; the service-layer `writeSummary`/`end` validation still guards the effective cap for the MCP path). No DB migration (`SUMMARY_MAX_CHARS`, the DB CHECK, and write precedence are unchanged).
- **Plugin:** `apps/plugin/.hermes-plugin/__init__.py` (`_api_request` error-body logging); parity check of `apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/scripts/_api.sh`.
- **Tests:** `api-router.test.ts` (summary/end truncate-not-reject, including a UTF-16-vs-code-point emoji case), invariant/parity where applicable.
- **Invariants:** append-only, scope-at-service, `topic_key`, and write-once-`final` precedence all untouched — this only relaxes an over-strict transport-length rejection into the already-intended truncation.
- **Distribution discipline:** touches `apps/plugin/` → `rembric-plugin-development` skill (four clients, parity, e2e against `dev:docker:up`). e2e MUST reproduce the emoji-over-cap 400 and confirm it now truncates + persists.
