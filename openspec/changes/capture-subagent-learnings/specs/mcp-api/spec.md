## MODIFIED Requirements

### Requirement: `memory.capture_passive` MUST use the same curation path as `memory.save`

`memory.capture_passive` is the tool the protocol steers agents toward for bulk persistence, so it SHALL NOT be a weaker write path. Its input SHALL require batch-level `tags: string[]` containing 1–64 strings, alongside `text: string` and optional `sessionId: string`. Each extracted learning SHALL receive the supplied batch tags and SHALL be saved through the same pipeline as `memory.save`: service-boundary tag normalization and validation before any transaction, convergent-topic handling, inline embedding before candidate detection, and save-time candidate detection. The response SHALL aggregate the detected `candidates[]` so conflicts introduced by a bulk capture are surfaceable and judgeable, rather than silently accumulating unlinked rows that are additionally invisible to the dense search branch until a background drain reaches them.

The extraction and the per-item save loop SHALL be one function in `packages/core`, shared by this tool and by `POST /api/<slug>/sessions/:id/learnings` (`http-api`). Each surface keeps its own scope resolution, authorization and session resolution, then calls that function. Neither SHALL carry a second copy of the heading match, the item extraction or the save loop.

An extracted item SHALL NOT be saved again when an active memory attached to the same session, in the same scope, already has the same content after redaction. The duplicate check and the insert for one item SHALL run in the same transaction, so two concurrent captures of the same text cannot both insert it. The response SHALL report the number of items skipped this way in an additive `skipped: number` field, which is `0` when nothing was skipped. When every extracted item is skipped, the response SHALL carry a `reason` saying the learnings were already captured in this session. When no session resolves for the capture, no item is skipped. The skip is an exact-content guard against repeated forwarding of one report. Near-duplicates remain the job of save-time candidates.

This required-tag contract supersedes the tagless `{ text: string, sessionId?: string }` shorthand in "The MCP server MUST expose three research tools". That requirement's extraction rules, reference type, scope behavior, and context/timeline contracts are otherwise unchanged. Its no-learnings success scenario presupposes valid required tags; missing or structurally invalid tags SHALL be rejected even when text contains no learning block. Existing additive response requirements, including `candidatesDetected`, remain in force.

#### Scenario: A bulk capture surfaces a conflict

- **GIVEN** an existing active memory that semantically conflicts with one of the extracted learnings
- **WHEN** `memory.capture_passive` saves that learning with valid batch tags
- **THEN** the response SHALL include a candidate referencing the existing memory, and a pending relation SHALL have been recorded

#### Scenario: Captured rows are immediately searchable by the dense branch

- **WHEN** `memory.capture_passive` saves a learning with valid batch tags
- **THEN** that row's embedding SHALL have been computed before the call returns, so a subsequent `memory.search` vector branch can surface it

#### Scenario: Batch tags reach every learning and normalize once at the shared boundary

- **WHEN** a valid capture request contains two extracted learnings and `tags: [' Dashboard ', 'Deploy / Docker', 'deploy_docker']`
- **THEN** each persisted memory SHALL have `['dashboard', 'deploy-docker']` in that order
- **AND** no inference call or per-learning tag-selection call SHALL be required

#### Scenario: Invalid supplied tags prevent capture writes

- **WHEN** a capture containing multiple learnings supplies a NUL-containing tag or a tag yielding no Unicode word runs, each case tested separately
- **THEN** it SHALL fail with `invalid_input` naming `tags` before saving the first learning
- **AND** it SHALL create no memory or relation rows

#### Scenario: Capturing the same text twice in one session saves it once

- **GIVEN** a session `S` and a text whose `## Key Learnings` section has three items
- **WHEN** `memory.capture_passive` is called twice with that text, `sessionId: S` and valid tags
- **THEN** the first call SHALL return `saved: 3, skipped: 0`
- **AND** the second call SHALL return `saved: 0, skipped: 3` with a `reason` naming the earlier capture
- **AND** exactly three memories SHALL be attached to `S`

#### Scenario: The skip is per session

- **GIVEN** the three items above already captured in session `S`
- **WHEN** the same text is captured with `sessionId: T`, another session of the same project
- **THEN** three new memories SHALL be saved and attached to `T`

#### Scenario: The tool and the HTTP route share one capture path

- **GIVEN** a text already captured in session `S` through `POST /api/<slug>/sessions/S/learnings`
- **WHEN** `memory.capture_passive` is called with that text and `sessionId: S`
- **THEN** it SHALL return `saved: 0` and `skipped` equal to the number of extracted items
