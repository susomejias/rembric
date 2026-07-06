## ADDED Requirements

### Requirement: Transcript-derived uploads MUST redact `<private>` spans client-side in every client

Any transcript-derived text a plugin sends to the server (session summaries, transcript snapshots, stop/pre-compact payloads, derived titles) SHALL have every `<private>…</private>` span replaced with `[REDACTED]` BEFORE the payload leaves the client. Matching SHALL be case-insensitive, SHALL span newlines, SHALL close each span at the first `</private>`, and an unclosed `<private>` SHALL redact through end-of-text (fail closed). All four clients (Claude Code, Codex CLI, Hermes Agent, opencode) SHALL implement identical observable semantics; the server SHALL NOT be relied upon to strip these tags.

#### Scenario: Private span in a bash-client transcript upload

- **WHEN** a Claude Code or Codex CLI session transcript contains `Connect to <private>postgresql://u:p@host/db</private> now`
- **THEN** every payload POSTed by the hook scripts SHALL contain `Connect to [REDACTED] now` and the original span SHALL NOT appear anywhere in the request body

#### Scenario: Multiline and case-variant spans

- **WHEN** the transcript contains `<PRIVATE>line one\nline two</Private>`
- **THEN** the uploaded text SHALL replace the whole span with a single `[REDACTED]`

#### Scenario: Unclosed private tag fails closed

- **WHEN** the transcript contains `<private>secret with no closing tag` followed by end-of-text
- **THEN** the uploaded text SHALL be redacted from the opening tag through end-of-text

#### Scenario: Hermes transcript formatting redacts before POST

- **WHEN** the Hermes plugin formats transcript entries containing a `<private>` span for upload
- **THEN** the formatted payload SHALL contain `[REDACTED]` in place of the span
