## ADDED Requirements

### Requirement: Failed lifecycle POSTs MUST emit one stderr diagnostic in every client

When a session-lifecycle HTTP POST fails (non-2xx, connection error, timeout), the client plugin SHALL emit exactly one one-line diagnostic to stderr identifying the path and the failure (e.g. curl return code or HTTP status), and SHALL still exit/return success so the host agent is never broken by Rembric unavailability. This aligns the bash clients (Claude Code, Codex CLI) with the diagnostics opencode (`diag()`) and Hermes (`_stderr()`) already emit. The diagnostic SHALL NOT include the request body or the token.

#### Scenario: Bad token configured in a bash client

- **WHEN** a Claude Code or Codex CLI hook POSTs a lifecycle event and the server responds `401`
- **THEN** the hook SHALL print one `[rembric] POST <path> failed …` line to stderr and SHALL exit 0

#### Scenario: Server unreachable

- **WHEN** the configured server is down during a lifecycle POST
- **THEN** the hook SHALL print one stderr diagnostic and SHALL exit 0 without delaying the host beyond curl's existing bounds
