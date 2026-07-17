## Why

Four independent session/scope bugs in the Hermes (Python) and opencode (TS) provider-level plugins, grouped by client because each is a distinct file-local checklist item rather than shared plumbing. All four were verified empirically by reading the actual current code before drafting fixes:

- **Hermes slug cascade contradicts its own manifest.** `_resolve_slug` (`apps/plugin/.hermes-plugin/__init__.py`) tries `REMBRIC_PROJECT_SLUG` env → `.rembric` → URL, in that order — but `plugin.yaml`'s `requires_env` description tells the installing user the opposite: "Default project slug. Overridden per-cwd if a .rembric file is present." Most Hermes users set `REMBRIC_PROJECT_SLUG` once via the install flow, so every repo's Hermes session registers under that one global slug and a per-repo `.rembric` is silently ignored — while the MCP bridge (which only reads `.rembric`) scopes memory tools to the correct project. Session rows and memories for the same repo end up split across two different projects.
- **Hermes' subagent/cron/flush suppression only gates the initial POST.** `initialize` reads `agent_context` as a local variable and skips the first `/sessions` POST for non-primary contexts, but never persists that decision. `sync_turn`, `on_pre_compress`, and `on_session_end` then POST to `/sessions/<id>/summary` or `/end` for a session row that was never created, hitting the server's `session_not_found` error on every turn. `on_session_switch` is worse: it unconditionally POSTs `/sessions` for the new id regardless of `agent_context`, defeating the suppression the moment a subagent session compresses or switches.
- **opencode never registers a pre-existing session it resumes into.** `knownSessions` is populated only by the `session.created` and `experimental.session.compacting` handlers. `chat.message` — which fires on every user turn, including the first turn of a session opencode resumed after a restart without re-emitting `session.created` — never calls `ensureSession`, so `flushSessionSummary` silently no-ops for that session while the save/summary/recall nudges (which are not gated on `knownSessions`) keep instructing the model to pass a `sessionId` the server has never seen.
- **Hermes' sync-lock proceeds without the lock on an acquire timeout.** `sync_turn`'s background thread does `acquired = self._sync_lock.acquire(timeout=5.0)` and then POSTs unconditionally in the `try` block; only the `finally`'s `release()` is gated on `acquired`. A hung POST — the exact case the timeout exists to protect against — lets a second thread's unsynchronized POST race it, and a stale transcript can overwrite a newer one.

## What Changes

- **Hermes slug cascade reordered to `.rembric` first**, matching the documented "overridden per-cwd" contract: `.rembric` → env → URL → `None`. This is a genuine behavior change (not just a docs fix) because the practical harm described above — session/memory split across projects — is only closed by actually changing precedence; leaving the code as-is and only editing the docstring would just stop the contradiction from being visible without fixing the misattribution.
- **`agent_context` suppression becomes persistent provider state** (`self._suppressed`, set once in `initialize`), and `sync_turn`, `on_pre_compress`, `on_session_end`, and `on_session_switch` all check it before making any HTTP call.
- **`chat.message` calls `await ensureSession(input.sessionID)`** before accumulating — idempotent (an already-known session is a no-op), closing the gap regardless of whether opencode re-emits `session.created` on resume.
- **`sync_turn` returns immediately if the lock acquire times out**, instead of proceeding unsynchronized — the next `sync_turn` call resends the full accumulated transcript anyway, so no data is lost by skipping one write.

No changes to the shared bash plumbing, the MCP bridge, or the server. No flag/env/protocol changes visible to a well-behaved primary-context session — every fix is either a precedence correction (Hermes slug) or closes a gap in an existing suppression/registration mechanism.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `hermes-agent-plugin`: the "Slug resolution cascade" requirement's precedence order changes (REMOVE + ADD under a new title, since the old title's meaning inverts — the OpenSpec archiver treats a MODIFIED requirement's scenario names as append-only, so a genuine precedence flip needs a fresh requirement, not a same-titled edit). The "Provider lifecycle method behavior" requirement gains suppression-propagation and lock-timeout scenarios. The "Provider MUST override `on_session_switch`" requirement gains a suppression scenario.
- `opencode-plugin`: the "Chat.message handler accumulates user transcript" requirement gains an `ensureSession` registration step and scenario.

## Impact

- `apps/plugin/.hermes-plugin/__init__.py` — `_resolve_slug`, `initialize`, `sync_turn`, `on_pre_compress`, `on_session_end`, `on_session_switch`.
- `apps/plugin/.hermes-plugin/tests/test_slug_resolution.py` — reorder assertions to match the new precedence.
- `apps/plugin/.opencode-plugin/plugin.ts` — `chat.message` handler.
- New/extended tests in both plugins' test suites.
- Verified end-to-end against a live `pnpm run dev:docker:up` server where practical (Hermes provider is a Python module with no live Hermes host available in this environment — direct handler invocation via the existing Python test harness covers the logic; opencode is verified via its existing `pnpm exec tsx` / test-suite pattern).
- Issue: #261.
