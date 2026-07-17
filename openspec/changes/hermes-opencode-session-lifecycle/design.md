## Context

Four bugs across two client providers, discovered in issue #261's review pass. Grouped by "provider-level session/scope correctness," distinct from the shared shell plumbing fixed in `plugin-shell-robustness`. All four were re-verified directly against the current source before drafting (line numbers in the issue had drifted slightly from the code read during this change, but every described bug reproduces as written).

## Goals / Non-Goals

**Goals:**

- Close each of the four bugs with the minimal correct fix.
- For the Hermes slug cascade, actually fix the misattribution (reorder precedence), not just the docs/code contradiction — the issue's own framing names "session rows and memories land in different projects" as the harm, and that harm survives a docs-only fix.
- Keep the OpenSpec delta scenario-append-only rule intact by using REMOVE+ADD (new title) instead of a same-titled MODIFIED where a scenario's _meaning_ inverts.

**Non-Goals:**

- Not touching `_api.sh`/`_transcript.sh`/`prompt-nudge.sh` — already fixed in `plugin-shell-robustness` (#260).
- Not adding a Hermes-side integration test against a real Hermes host — none is available in this environment; the existing Python unit-test harness (`tests/test_slug_resolution.py` and friends) already exercises the provider class directly without a live host, and that pattern is reused here.
- Not changing the opencode `session.created`/`experimental.session.compacting` registration paths — `ensureSession` is already idempotent and already called from both; the fix only adds a third, missing call site.

## Decisions

### D1. Hermes slug cascade: reorder, don't just re-word

Two fixes were on the table (per the issue): reorder the cascade to `.rembric`-first, or rewrite `plugin.yaml` + the `requires_env` docstring to admit env wins. The docs-only fix is lower-risk (no behavior change, no test churn) but leaves the actual harm — a global env slug silently overriding a per-repo `.rembric` — in place; it would only make the _contradiction_ disappear, not the _misattribution_. Given every other fix in this change closes a real behavioral gap rather than papering over one, the cascade is reordered: `.rembric` → env → URL → `None`. `REMBRIC_PROJECT_SLUG` remains useful as a fallback default for repos that never got a `.rembric` file (e.g. a scratch directory, or before the TUI installer writes one).

This is the one genuinely user-visible behavior change in the package: a Hermes user who was relying on env-always-wins (e.g., deliberately overriding a stale/wrong `.rembric` via env) will see the opposite after upgrading. This is called out explicitly in the CHANGELOG entry (conventional-commit body) as a behavior change, not hidden inside a "fix" bullet.

### D2. OpenSpec scenario-append-only rule forces REMOVE+ADD for the cascade requirement, not MODIFIED

`openspec archive`'s `findMissingCurrentScenarios` check (`specs-apply.js`) compares scenario _names_ between the current spec's requirement block and the incoming MODIFIED block; any current name absent from the incoming block throws, even if the same name's _content_ changed. There is no scenario-level RENAME or REMOVE operation — only requirement-level REMOVED/ADDED/RENAMED. The "Slug resolution cascade" requirement's `Env wins over .rembric file` scenario has no honest equivalent under the new precedence (the opposite is now true), so a same-titled MODIFIED would either keep a now-false scenario title or get rejected for silently dropping it. The requirement is instead REMOVED under its original title and ADDED under a new title, "Slug resolution cascade order" (distinct after normalization, so it doesn't collide with the REMOVED entry's name in `specs-apply.js`'s cross-section conflict check), carrying five fresh scenarios: three preserved verbatim in substance (`.rembric wins over URL`, `URL parse is the final source`, `Invalid candidate is skipped`, `All sources empty yields None` — the first of these renamed to `.rembric wins over env` since it's now testing a different pair of sources) plus the reordered precedence text.

### D3. Suppression as persistent state, checked at every HTTP call site

`self._suppressed = kwargs.get("agent_context", "primary") in _NON_PRIMARY_AGENT_CONTEXTS`, set once in `initialize` alongside the existing slug/base/session_id caching. `sync_turn`, `on_pre_compress`, `on_session_end`, and `on_session_switch` each gain `or self._suppressed` in their existing early-return guard (all four already guard on `not self._initialized or not self._slug or not self._base or not self._session_id`, so this is a one-token addition per site, not new control flow). `on_session_switch`'s registration POST for the _new_ session id is also suppressed — a subagent that switches sessions is still a subagent.

### D4. `ensureSession` at the top of `chat.message`, not inside a new gate

`chat.message` already returns early for `subAgentSessions` (line 1 of its handler). `ensureSession` is idempotent (`if (knownSessions.has(sessionId)) return`) and already the correct call used by `session.created` and `experimental.session.compacting`, so the fix is `await ensureSession(input.sessionID)` immediately after the subagent check, before `appendUserMessage`. No new state, no new suppression logic — it closes the resume gap unconditionally, regardless of whether opencode's upstream behavior on resume-after-restart ever changes.

### D5. Sync lock: return, don't proceed, on timeout

`sync_turn`'s inner `_sync()`: `acquired = self._sync_lock.acquire(timeout=5.0)`, then `if not acquired: return` before building the transcript or POSTing, inside the existing `try/finally` (the `finally`'s `if acquired: self._sync_lock.release()` is unchanged — it was already correctly gated). The next `sync_turn` call (fired on the very next turn) resends the full accumulated transcript, so a skipped write here is not a lost write, only a delayed one.

## Verification

- **Hermes** (`apps/plugin/.hermes-plugin/tests/`): extend `test_slug_resolution.py` — rename/invert `test_env_wins_over_dotrembric` to `test_dotrembric_wins_over_env`, add `test_env_wins_when_no_dotrembric`; add suppression-propagation tests asserting `sync_turn`/`on_pre_compress`/`on_session_end`/`on_session_switch` make zero HTTP calls when `agent_context` was non-primary at `initialize`; add a sync-lock-timeout test using a pre-held lock to force the timeout path and asserting no POST occurred.
- **opencode** (`apps/plugin/test/` or the plugin's own test file — confirmed at implementation time): a `chat.message`-first-turn test for a session with no prior `session.created`, asserting the session gets registered (via the mocked/stubbed `fetch` seeing a `POST /sessions` call) before the summary flush fires.
- Full existing suites (`pytest` for Hermes, `pnpm vitest run` for opencode/plugin) stay green.
- Live `dev:docker:up` e2e is not practical for the Hermes provider (no Hermes host in this environment) — direct Python module invocation against the real provider class (as the existing test suite already does) is the closest available proof and is what's used. The opencode fix is small enough (`ensureSession` idempotency is already spec'd and tested elsewhere) that the unit-level test plus a manual read of the resulting diff is sufficient; call this out explicitly rather than claiming e2e coverage that wasn't run.

## Migration Plan

No schema/protocol change. The Hermes slug-precedence change is a behavior change flagged in the PR description and CHANGELOG (conventional-commit body, not a footgun buried in a bullet list) so operators relying on env-always-wins know to add/adjust a `.rembric` file. Rollback is a plain revert.
