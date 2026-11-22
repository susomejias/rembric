## ADDED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/learnings` MUST capture the Key Learnings of a subagent report into session `:id`

Plugin hooks speak HTTP, and a subagent's report reaches the plugin only as text. The server SHALL expose `POST /api/<slug>/sessions/:id/learnings`, which saves the `## Key Learnings` items of that text as memories attached to session `:id` — the parent session that delegated to the subagent.

The route SHALL follow the shared `/api/<slug>/sessions/:id/*` sequence:

1. authenticate the bearer token;
2. `404 project_not_found` for an unknown slug;
3. `403` unless the token may write to that project;
4. `404 session_not_found` when `:id` belongs to another token or project, or does not exist; `409 session_deleted` when it is soft-deleted;
5. `400 invalid_input` for an invalid body.

Every other method SHALL answer `404 not_found`, as on the sibling routes.

The body SHALL be an object with `report: string` (at least 1 character) and optional `agentType: string` (1–120 characters). Unknown properties SHALL be ignored.

The route SHALL:

- take the last 50,000 code points of `report`. The learnings section closes a report, so a report longer than the `memory.capture_passive` text cap keeps the part that matters;
- extract and save the items through the same core capture function as `memory.capture_passive` (`mcp-api`), so redaction, tag normalization, inline embedding, save-time candidate detection and the same-session duplicate skip are identical;
- assign the batch tags itself: `subagent-learning`, followed by `agentType` when it is present and normalizes to a non-empty tag. An `agentType` that normalizes to nothing SHALL be dropped, not rejected;
- record each memory's provenance as `source.tokenName` = the token's name and `source.agent` = `subagent`.

On success it SHALL answer `200 { ok: true, saved, skipped, ids, candidatesDetected }`, adding `reason` when `saved` is `0`. A report with no learnings section SHALL be a `200` with `saved: 0`, `skipped: 0` and a `reason` naming the expected heading form. That is a normal outcome for a report without learnings, not an error. The response SHALL NOT include the candidate list: the caller is a hook with no agent to judge it. The pending relations recorded at save time reach an agent through `memory.context.pendingJudgments[]`.

#### Scenario: A report's learnings are saved into the parent session

- **GIVEN** an active session `P` owned by the calling token in project `<slug>`
- **WHEN** a client POSTs `{"report": "Done.\n\n## Key Learnings\n1. The parser drops BOMs.\n2. Retries cap at three.", "agentType": "Explore"}` to `/api/<slug>/sessions/P/learnings`
- **THEN** the response SHALL be `200` with `saved: 2`, `skipped: 0` and two ids
- **AND** both memories SHALL have `type: reference`, `session_id = P`, tags `['subagent-learning', 'explore']` and `source.agent = 'subagent'`
- **AND** both SHALL have embeddings before the response is sent

#### Scenario: A report without learnings is a no-op

- **WHEN** a client POSTs `{"report": "Found three endpoints."}` to the route for an active session
- **THEN** the response SHALL be `200` with `saved: 0`, `skipped: 0` and a `reason` naming the `## Key Learnings` heading
- **AND** no memory row SHALL be created

#### Scenario: The same report forwarded twice is saved once

- **GIVEN** the first scenario's report already captured into `P`
- **WHEN** the identical body is POSTed again to `/api/<slug>/sessions/P/learnings`
- **THEN** the response SHALL be `200` with `saved: 0` and `skipped: 2`
- **AND** session `P` SHALL still carry exactly two memories from that report

#### Scenario: A long report keeps its closing learnings

- **WHEN** a client POSTs a report of 120,000 characters whose last 300 characters are a `## Key Learnings` list of two items
- **THEN** the response SHALL be `200` with `saved: 2`

#### Scenario: Another token's session is refused

- **GIVEN** session `P` registered by token A
- **WHEN** token B, with write access to the same project, POSTs a valid body to `/api/<slug>/sessions/P/learnings`
- **THEN** the response SHALL be `404` with code `session_not_found`
- **AND** no memory row SHALL be created

#### Scenario: A read-only token is refused

- **WHEN** a token with read-only access to the project POSTs a valid body
- **THEN** the response SHALL be `403` and no memory row SHALL be created

#### Scenario: An invalid body is refused

- **WHEN** a client POSTs `{"report": ""}` or `{"report": 42}` or `{"agentType": "x"}`
- **THEN** the response SHALL be `400` with code `invalid_input` naming `report`

#### Scenario: An agentType that normalizes to nothing is dropped

- **WHEN** a client POSTs a report with two learnings and `"agentType": "::"`
- **THEN** the response SHALL be `200` with `saved: 2`
- **AND** both memories SHALL carry exactly the tags `['subagent-learning']`
