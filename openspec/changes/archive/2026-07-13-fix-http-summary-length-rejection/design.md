## Context

The HTTP session endpoints intentionally split responsibility with the MCP tools: MCP `memory.session_summary` **rejects** over-cap input (the agent can retry), while the HTTP raw-sync path (`/summary`, `/end`) — used by non-interactive hook/plugin writers that cannot react to an error — is documented to **truncate** server-side. Today's flow: zod wire cap (`summary.max(20_000)`) → `truncateSummary` (to `SUMMARY_MAX_CHARS = 10000`) → service.

The bug: `truncateSummary` uses JS `.slice`/`.length` (UTF-16 units), and so does the zod `.max()`, but the **plugins truncate by Unicode code points** (`len()` in Python; the same in Bash/`_format_transcript`). The zod wire cap (20 000) equals the plugins' code-point cap (20 000) with **zero margin**, so a body the plugin believes is compliant (≤20 000 code points) can measure >20 000 UTF-16 units and be rejected at the wire boundary — _before_ `truncateSummary` runs. Emoji (2 UTF-16 units each) make this routine for Hermes. `title` has the identical latent defect (`max(100)`, and it is **not** truncated server-side at all — it is passed straight to the service, which also rejects `>100`).

Confirmed: reproduced the zod mismatch in isolation; deduced as the _only_ path to a 400 in the plugin's 0.18.1 code (body is `{summary, final}`, guard prevents empty, `final` is boolean); matches the user's production logs exactly (400 per turn on emoji/large conversations, correct session id throughout).

## Goals / Non-Goals

**Goals:**

- The HTTP raw-sync path never returns `invalid_input` for an over-length `summary` or `title` — it truncates and returns `200 OK`, as its contract already promises.
- Close the code-point↔UTF-16 cliff so a plugin body that respects its own char cap can never be rejected by the server's wire guard.
- Make this class of failure diagnosable from client logs without hand-instrumenting production.

**Non-Goals:**

- Changing `SUMMARY_MAX_CHARS` (10 000), the DB CHECK, or write-once-`final` precedence.
- Changing the MCP path's reject-and-retry behavior.
- Re-architecting session routing (already ruled out as the cause).

## Decisions

### D1: Truncate, not reject, on the HTTP path — for BOTH `summary` and `title`

The `/summary` and `/end` handlers truncate an over-length `summary` (already done) AND `title` (new: a `truncateTitle` sibling) to their effective caps before the service call, returning `200 OK`. Rationale: hook/plugin writers cannot react to `invalid_input`; the contract already says truncate. Rejecting is the current, broken behavior.

- **Alternatives:** (a) fix only the Hermes plugin's truncation — rejected, leaves the same cliff for opencode/bash/Codex and every future client; (b) keep rejecting and tell plugins to truncate smaller — rejected, fragile coupling of two caps across a language boundary.

### D2: Re-express the wire DoS guard with margin (recommended) vs. drop the char cap

The zod `summary` cap must not sit exactly at the plugins' code-point cap. Two options:

- **(A, recommended)** Raise the zod `max` for `summary` on the HTTP schemas to a value ≥ the worst-case UTF-16 expansion of the plugins' code-point truncation (20 000 code points → up to 40 000 UTF-16 units), e.g. `40_000`. Smallest change; the guard stays where it is; `truncateSummary` still cuts to 10 000, so stored content is unchanged. The "wire-DoS at 20 001" scenario becomes "at 40 001".
- **(B)** Drop the char-count `.max()` on the HTTP `summary` entirely and rely on `truncateSummary` + a transport-level request body-size limit (bytes) as the real DoS guard. Conceptually cleaner (length is a service concern, bytes are the transport concern) but touches more (needs a body-size limit if not already enforced by the HTTP layer).
- Leaning A for minimal blast radius; apply confirms whether a body-size limit already exists that would make B free.

### D3: `title` truncation semantics

Add `truncateTitle` (cap = `TITLE_MAX_LENGTH = 100`, UTF-16, matching the service). The HTTP handler truncates `title` before the service call; the wire cap for `title` also gets margin (or is dropped per D2). The MCP path still rejects an over-cap title. Truncating a placeholder/derived title to 100 is already the intended shape (plugin and service both cap at 100) — silent truncation here is consistent, not lossy in any meaningful way.

### D4: Server is the single source of truth for tolerance; do NOT change plugin truncation

With the server tolerating and truncating, plugins need no change to their truncation logic. Keeping plugin code-point truncation as-is avoids touching four clients for a server-side guarantee.

- **Alternative:** also switch plugins to UTF-16-aware truncation as defense-in-depth — rejected for now (unnecessary once the server tolerates; would spread the change across all clients). Revisit only if a body-size (bytes) limit makes raw payload size matter.

### D5: Log the HTTP error body in the plugin

`_api_request` currently logs `POST {path} failed: {err}` (just "HTTP Error 400"). Add the response body (`err.read()` for `HTTPError`) so the `{code, message}` is visible in `journalctl`. The body is `{code, message}` only — never conversation content — so this is safe to log. Apply with parity to opencode/bash where they are equally blind.

## Risks / Trade-offs

- **[Risk]** Raising the wire cap weakens the DoS guard. → **Mitigation:** the guard still exists (40 000 is a modest ceiling), and `truncateSummary` still cuts stored content to 10 000 — nothing larger is persisted. If option B is taken, a byte-level body-size limit replaces it.
- **[Trade-off]** Silent server-side `title` truncation could hide an over-long title. → **Accepted because** the title is a short derived/placeholder label already capped at 100 by both plugin and service; truncation is the intended shape, and the MCP (agent) path still rejects so a cooperating agent gets feedback.
- **[Risk]** Some other length cap has the same code-point↔UTF-16 skew. → **Mitigation:** audit during apply — `truncateSummary` (UTF-16) and the zod cap (UTF-16) are mutually consistent; the only skew is plugin(code points) vs server(UTF-16), which D1/D2 close for the two HTTP fields that plugins send.

## Migration Plan

No DB migration. Server + plugin text/logic edits. Rollback = revert the commit. Single unified `plugin` version bump for the logging change; server release for the endpoint change. Validate e2e against `pnpm run dev:docker:up`: POST a `summary` of 20 000 code points containing emoji (>20 000 UTF-16) and assert `200 OK` + truncated persisted value (pre-fix this is the 400 the user hit).

## Open Questions — RESOLVED at apply time

- **D2 resolved: Option A.** Checked whether `/api/<slug>/sessions*` already has a byte-level body-size guard that would make Option B free. It does NOT: `apps/server/src/server/http.ts`'s `maxBodyBytes`/`readJsonBody` guard (line ~193-194) is gated to `pathname === '/mcp' || pathname.startsWith('/mcp/')` only; every other path (including `/api/*`) falls through to `honoListener(req, res)` (line 203), which uses Hono's own unbounded `c.req.json()`. This means the `http-api` spec's "authenticated HTTP surface MUST bound request body size… `/mcp` (POST/DELETE) and `/api/<slug>/sessions*`" requirement is **not actually implemented** for the `/api/*` half — a separate, pre-existing spec/implementation mismatch, out of scope here (see tasks.md 6.3 follow-up). Since Option B would require closing that gap too (expanding blast radius well beyond this bug), **Option A is adopted**: raise the zod `max` for `summary` on the HTTP schemas from `20_000` to `40_000` (double, comfortably ≥ the worst-case 2× UTF-16 expansion of a 20 000-code-point plugin transcript), keeping `truncateSummary`'s effective cut at `SUMMARY_MAX_CHARS` (10 000) unchanged. `title`'s zod `max` is similarly raised from `100` to `200` for the same margin, with the new `truncateTitle` cutting to `TITLE_MAX_LENGTH` (100).
- **`truncateTitle` semantics resolved: hard-cut, no suffix.** Titles are short, single-line, already-capped-at-100 labels (placeholder or derived first-assistant-message); consistent with how the plugin/service already treat titles (`title[:100]` in Python, no ellipsis). A suffix would waste scarce characters on a label, unlike the summary where `…[truncated]` signals to the operator that content was cut.
