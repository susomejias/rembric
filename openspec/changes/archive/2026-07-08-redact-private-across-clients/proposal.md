# Redact `<private>` spans in every client, not only opencode

## Why

The opencode plugin replaces `<private>…</private>` spans with `[REDACTED]` before uploading transcript text (speced in `opencode-plugin` spec, implemented in `apps/plugin/.opencode-plugin/plugin.ts`). The other three clients — Claude Code and Codex CLI (shared bash scripts `apps/plugin/scripts/_transcript.sh` → `session-end.sh`/`session-stop.sh`/`pre-compact.sh`) and Hermes Agent (`apps/plugin/.hermes-plugin/__init__.py::_format_transcript`) — upload the same kind of transcript-derived text with NO redaction, and the server does not strip the tags either. A user who relies on the documented-by-behavior redaction leaks "private" content in 3 of 4 clients.

## What Changes

- **NEW** cross-client requirement in `plugin-session-protocol`: any transcript-derived text a plugin POSTs to the server SHALL have `<private>…</private>` spans (case-insensitive, spanning newlines) replaced with `[REDACTED]` before the payload leaves the client.
- **MODIFIED** bash transcript pipeline (`apps/plugin/scripts/_transcript.sh`): redaction applied at the extraction choke point, so every consumer (Claude Code + Codex CLI hooks) inherits it.
- **MODIFIED** Hermes transcript formatting (`apps/plugin/.hermes-plugin/__init__.py`): same redaction in `_format_transcript` (or its single upload choke point).
- opencode implementation unchanged (already compliant); its behavior becomes the normative reference.
- Docs: document the `<private>` convention once, as a supported cross-client feature (`apps/plugin/README.md`, `docs/agents.md`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `plugin-session-protocol`: adds the cross-client redaction requirement (transcript-derived uploads redact `<private>` spans client-side).

## Impact

- `apps/plugin/scripts/_transcript.sh` (+ its consumers `session-end.sh`, `session-stop.sh`, `pre-compact.sh` — no changes expected there if the choke point holds).
- `apps/plugin/.hermes-plugin/__init__.py`.
- Docs: `apps/plugin/README.md`, `docs/agents.md`, `README.md` (feature mention).
- Tests: bash redaction cases (vitest shell-out harness alongside the existing plugin tests), Hermes test suite (`pnpm run test:hermes-plugin`), opencode tests untouched.
- This is a plugin-track change (bumps the unified `plugin` component; no server rebuild).
- Bash and Python keep their own implementations (cross-language wrapper > duplication, same rule as the dotenv parser); the regex semantics MUST match the opencode reference.
