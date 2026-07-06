# Tasks — redact-private-across-clients

## 1. Shared fixtures

- [x] 1.1 Create a fixture set (plain span, multiline span, case variants, multiple spans, unclosed tag, text without tags) in `apps/plugin/` test space, with expected outputs, to be exercised against all implementations.

## 2. Bash (Claude Code + Codex CLI)

- [x] 2.1 Add `rembric_redact_private` (POSIX awk state machine per design D2) to `apps/plugin/scripts/_transcript.sh` and apply it at the extraction choke point(s) so session-end, session-stop, pre-compact, and title derivation all inherit it; verify with `sh -n` and by grepping consumers for direct un-redacted extraction paths.
- [x] 2.2 Vitest shell-out tests running the fixtures through the bash function (BSD awk on macOS; CI covers GNU awk).

## 3. Python (Hermes)

- [x] 3.1 Apply `re.sub(r'<private>.*?</private>', '[REDACTED]', text, flags=re.I | re.S)` plus the unclosed-tag EOF fallback in `_format_transcript` (or the single upload choke point) in `apps/plugin/.hermes-plugin/__init__.py`.
- [x] 3.2 Fixture tests in the Hermes suite; `pnpm run test:hermes-plugin` green.

## 4. opencode alignment

- [x] 4.1 Extend `stripPrivateTags` in `apps/plugin/.opencode-plugin/plugin.ts` with the unclosed-tag EOF fallback (design D2 note); fixture tests in the existing opencode plugin test file.

## 5. Docs & gates

- [x] 5.1 Document the `<private>` convention as cross-client in `apps/plugin/README.md` and `docs/agents.md` (one section, not per client).
- [x] 5.2 `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run test:hermes-plugin && openspec validate redact-private-across-clients --strict` all green.
- [ ] 5.3 NOT VERIFIED HERE (operator/e2e): live e2e against `pnpm run dev:docker:up` — deferred to the consolidated e2e pass for this batch; list it explicitly in the final report.
