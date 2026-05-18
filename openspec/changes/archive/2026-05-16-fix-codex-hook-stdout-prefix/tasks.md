## 1. Script changes

- [x] 1.1 Edit `plugin/scripts/session-start.sh`: change the final `echo` line from `'[rembric] If this is a continuation of recent work, call memory.context before responding.'` to `'rembric: If this is a continuation of recent work, call memory.context before responding.'`. Single-character semantic change; preserve indentation, surrounding logic, and `exit 0`.
- [x] 1.2 Edit `plugin/scripts/prompt-search.sh`: change the `echo` line from `'[rembric] User intent: recall. Call memory.search with the user keywords before responding.'` to `'rembric: User intent: recall. Call memory.search with the user keywords before responding.'`. Same shape.
- [x] 1.3 Sanity-check both files via `bash -n plugin/scripts/session-start.sh` and `bash -n plugin/scripts/prompt-search.sh`. Should report no syntax errors. Confirm `head -1` of each is still `#!/usr/bin/env bash`.

## 2. Manifest + CHANGELOG

- [x] 2.1 Bump `plugin/.claude-plugin/plugin.json:version` from `0.2.2` to `0.2.3`.
- [x] 2.2 Bump `plugin/.codex-plugin/plugin.json:version` from `0.2.2` to `0.2.3` (CLAUDE.md lockstep rule).
- [x] 2.3 Add `## [0.2.3] — unreleased` heading to `plugin/CHANGELOG.md` above the existing `[0.2.2]` heading. Body bullets:
  - **Fixed**: Codex SessionStart and UserPromptSubmit hooks no longer fail with `error: hook returned invalid ... JSON output`. The bug was the leading `[` in the `[rembric]` badge prefix — Codex's `looks_like_json` heuristic (in `codex-rs/hooks/src/engine/output_parser.rs`) treats stdout starting with `[` or `{` as a JSON attempt. Switching the prefix from `[rembric]` to `rembric:` keeps the badge visible while staying inside Codex's plain-text branch.
  - **Changed**: hook stdout prefix moves from `[rembric]` to `rembric:`. Visible in `claude --debug` and `~/.codex/log/codex-tui.log` lines.
  - **Notes for existing users**: `codex plugin marketplace upgrade rembric` + restart Codex picks up the fix. Claude Code: `claude plugin update rembric@rembric`. No reinstall needed.

## 3. Spec deltas

- [x] 3.1 Confirm `openspec/changes/fix-codex-hook-stdout-prefix/specs/claude-code-plugin/spec.md` contains MODIFIED "The plugin SHALL ship exactly four hooks at `plugin/hooks/hooks.json`" with the updated nudge literals for SessionStart and UserPromptSubmit, and a new scenario "SessionStart nudge under Codex passes plain-text path".
- [x] 3.2 Confirm same spec delta file ALSO modifies "Hook script invariants" requirement with the new bullet about not starting stdout with `{` or `[`, and the matching scenario "Hook stdout starts with a safe prefix".
- [x] 3.3 Run `openspec validate fix-codex-hook-stdout-prefix --strict`. Confirm green.

## 4. Local verification

- [x] 4.1 Run `bash -n plugin/scripts/session-start.sh` and `bash -n plugin/scripts/prompt-search.sh`. Both should exit 0 with no syntax errors.
- [x] 4.2 Smoke-test session-start.sh locally with a fake stdin:
  ```sh
  echo '{"session_id":"test-abc","cwd":"/tmp"}' | REMBRIC_SERVER_URL='' REMBRIC_API_TOKEN='' plugin/scripts/session-start.sh codex-cli
  ```
  Expected stdout (last line): `rembric: If this is a continuation of recent work, call memory.context before responding.` Expected exit 0. (Empty REMBRIC env vars skip the POST; that's fine — we're only testing the stdout shape.)
- [x] 4.3 Run prompt-search.sh:
  ```sh
  echo '' | plugin/scripts/prompt-search.sh
  ```
  Expected stdout: `rembric: User intent: recall. Call memory.search with the user keywords before responding.` Expected exit 0.
- [x] 4.4 Confirm both stdouts start with `r` (not `[` or `{`).

## 5. Commit + push

- [ ] 5.1 Stage `plugin/scripts/session-start.sh`, `plugin/scripts/prompt-search.sh`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/CHANGELOG.md`, `openspec/changes/fix-codex-hook-stdout-prefix/**`.
- [ ] 5.2 Commit with `fix(codex): drop leading `[` from hook stdout so Codex's looks_like_json passes`. Body cites the Codex source file (`codex-rs/hooks/src/events/session_start.rs`) and the heuristic (`codex-rs/hooks/src/engine/output_parser.rs::looks_like_json`).
- [ ] 5.3 User confirms intent to push, then `git push origin main`.

## 6. Post-push smoke test

- [ ] 6.1 `codex plugin marketplace upgrade rembric`. Confirm `~/.codex/plugins/cache/rembric/rembric/` now contains a `0.2.3/` directory (or upgraded existing one).
- [ ] 6.2 Cold-restart `codex` from `~/Desktop/rembric`. Send any user prompt.
- [ ] 6.3 Tail `~/.codex/log/codex-tui.log` and confirm: NO `error: hook returned invalid session start JSON output` entries since the restart timestamp.
- [ ] 6.4 Confirm a new session row appears at `/dashboard/sessions` in the Rembric server with `agent=codex-cli` and `cwd=<repo>` (the local checkout path).
- [ ] 6.5 (Optional) Trigger the UserPromptSubmit recall matcher: send a prompt containing `recall` or `acordate`. Confirm no error in the log; the `rembric: User intent...` nudge should appear in the agent's reasoning trace.

## 7. Archive

- [ ] 7.1 If 6.x passes, archive via `/opsx:archive fix-codex-hook-stdout-prefix`. Spec delta will sync into `openspec/specs/claude-code-plugin/spec.md`.
- [ ] 7.2 If 6.x fails, capture the exact log line, diagnose, and update the change before archiving.
