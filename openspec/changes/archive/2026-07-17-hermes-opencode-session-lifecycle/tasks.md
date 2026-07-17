## 1. Hermes slug cascade

- [x] 1.1 Reorder `_resolve_slug` in `apps/plugin/.hermes-plugin/__init__.py` to `.rembric` → env → URL.
- [x] 1.2 Update `tests/test_slug_resolution.py`: invert `test_env_wins_over_dotrembric` → `test_dotrembric_wins_over_env`; add `test_env_wins_when_no_dotrembric`.
- [x] 1.3 Update `plugin.yaml`'s `requires_env` description if wording needs a tweak now that code matches it.

## 2. Hermes suppression propagation

- [x] 2.1 Store `self._suppressed` in `initialize`; gate `sync_turn`, `on_pre_compress`, `on_session_end`, `on_session_switch` (both the old-session `/end` POST and the new-session `/sessions` POST) on it.
- [x] 2.2 Tests: suppressed context makes zero HTTP calls across all four methods for the lifetime of the session.

## 3. Hermes sync-lock timeout

- [x] 3.1 `sync_turn`'s `_sync()`: return before building/POSTing when `acquire(timeout=5.0)` fails.
- [x] 3.2 Test: pre-held lock forces the timeout path; assert no POST occurred and the lock is left untouched (not released, since this thread never acquired it).

## 4. opencode resumed-session registration

- [x] 4.1 `chat.message`: `await ensureSession(input.sessionID)` after the subagent-session check, before `appendUserMessage`.
- [x] 4.2 Test: first `chat.message` for a session with no prior `session.created` registers it before flushing.

## 5. Spec + validation

- [x] 5.1 `hermes-agent-plugin` spec deltas: REMOVE+ADD "Slug resolution cascade"/"Slug resolution cascade order"; MODIFY "Provider lifecycle method behavior" and "Provider MUST override `on_session_switch`...".
- [x] 5.2 `opencode-plugin` spec delta: MODIFY "Chat.message handler accumulates user transcript".
- [x] 5.3 `openspec validate hermes-opencode-session-lifecycle --strict`.
- [x] 5.4 Full test suites (Hermes `pytest`, plugin `pnpm vitest run`) + `pnpm typecheck` + `pnpm lint`.
- [x] 5.5 Commit, `openspec archive --yes`, `openspec validate --specs`, push, open PR closing #261.
