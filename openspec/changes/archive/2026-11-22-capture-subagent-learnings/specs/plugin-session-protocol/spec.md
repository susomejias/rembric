## ADDED Requirements

### Requirement: Every client MUST forward a finished subagent's report to the parent session, silently and idempotently

A subagent's `## Key Learnings` are saved without the parent agent's cooperation: each client SHALL observe its host's subagent-completion signal and send the report to `POST /api/<slug>/sessions/<parent-id>/learnings` (`http-api`), where `<parent-id>` is the id the client already uses for the parent session in every other lifecycle call.

| Client | Signal | Report text | Parent id |
|---|---|---|---|
| Claude Code | `PreToolUse` matched on `SubagentHandback`; `SubagentStop` | `tool_input.message`; `last_assistant_message` | stdin `session_id` |
| Codex CLI | `SubagentStop` | `last_assistant_message` | stdin `session_id` |
| opencode 2.x | `session.inbox.enqueued` with a synthetic item whose `payload.metadata.source` is `subagent` | `payload.text`, without its `<subagent …>` wrapper | the event's `sessionID` |
| Pi | `tool_execution_end` for a recognised subagent tool; `message_end` for a recognised completion message | the result's or message's text content | the extension's own session id |
| Hermes | `subagent_stop` | `child_summary` | `parent_session_id` |

Every client SHALL:

- **pre-filter**: forward a report only when it contains the string `key learnings` in any letter case. This is deliberately looser than the server's heading match, so it can never drop a report the server would accept. The server's match stays authoritative.
- **redact**: replace `<private>…</private>` spans with `[REDACTED]` through that client's existing redaction helper before sending.
- **send only** `report`, plus `agentType` when the host names the subagent's type. It SHALL NOT send the task prompt, the transcript or any other field.
- **stay silent and non-blocking**: forwarding SHALL contribute nothing to the model's context. It SHALL NOT delay, deny or alter the subagent's completion or the parent's receipt of the report, and SHALL NOT change any tool result.
- **fail safe**: a failed POST SHALL produce exactly one stderr diagnostic, per "Failed lifecycle POSTs MUST emit one stderr diagnostic in every client", and nothing else.
- **not deduplicate on its own**: a client MAY forward the same report more than once (two signals for one subagent, at-least-once host delivery, one report per idle cycle). Idempotence is the server's same-session skip (`mcp-api`), not client state.

The JavaScript clients (opencode, Pi) SHALL send through one function of the shared core, `postSubagentReport(parentSessionId, report, agentType)`, which applies the pre-filter and the redaction. The bash clients (Claude Code, Codex) SHALL send through one `_api.sh` helper used by `subagent-report.sh`. Hermes keeps its own Python implementation, as for every other lifecycle call.

#### Scenario: Every client posts the same body for the same report

- **GIVEN** a parent session `P` and a subagent report `R` whose text contains `<private>k</private>` and ends in a `## Key Learnings` list
- **WHEN** each client's forwarder handles `R`, each tested separately
- **THEN** each SHALL POST to `/api/<slug>/sessions/P/learnings` a body whose `report` equals `R` with the private span replaced by `[REDACTED]`, as that client's existing redaction helper does
- **AND** no client SHALL emit anything into the model's context

#### Scenario: A report without the phrase is never sent

- **WHEN** any client's forwarder handles a report that does not contain `key learnings` in any letter case
- **THEN** it SHALL make no request

#### Scenario: Forwarding twice is harmless

- **GIVEN** a client that receives two signals for one subagent, both carrying the same report with two learnings
- **WHEN** both are forwarded
- **THEN** session `P` SHALL carry exactly two memories from that report

### Requirement: A post-tool observer MUST be filtered to subagent tools and MUST NOT reach the model

A client that observes tool completion SHALL do so only to forward a subagent report, filtered to subagent tools by name, and SHALL NOT reach the model.

The `PostToolUse` save nudge was removed (#235) because it counted tool calls to decide when to inject text into the model's context. That decision stands for context injection. Pi exposes a subagent's report only after the extension's tool completes, on `tool_execution_end`. On such a host, a client MAY observe tool completion for the sole purpose of forwarding a subagent report, under three conditions:

- the observer SHALL act only on tools named in that client's list of subagent tools, and return immediately for every other tool;
- it SHALL NOT modify the tool result, add context, or produce any model-visible output;
- it SHALL NOT count, rate or otherwise track tool calls.

The Claude Code and Codex manifests SHALL keep declaring no `PostToolUse` entry (`claude-code-plugin`, `codex-distribution`).

#### Scenario: A non-subagent tool is ignored

- **WHEN** the Pi extension observes `tool_execution_end` for tool `bash`
- **THEN** it SHALL make no request and leave the result unchanged

#### Scenario: A subagent tool result is forwarded unchanged

- **WHEN** the observer forwards the result of a recognised subagent tool
- **THEN** the tool result the model receives SHALL be byte-identical to the one it would receive with the plugin disabled
