## MODIFIED Requirements

### Requirement: `memory.save` MUST report how many candidates its detection produced

A bounded list whose depth is invisible cannot be told from a complete one. `memory.save` returns `candidates[]` capped by `CANDIDATES_PER_SAVE_MAX`, so a caller today cannot distinguish five-of-five from five-of-fifteen, and the pairs beyond the cap have no `memory_relations` row and therefore no `judgmentId` — making them unreachable from `memory.judge`, from `memory.context.pendingJudgments[]`, and from `/dashboard/judgments`, which is a view over that table. (The detection behaviour itself, including why those pairs are deliberately not recorded, belongs to the `memory` capability, "`memory.save` MUST surface candidate conflicts at save-time", and is not restated here.)

`memory.save` SHALL therefore return `candidatesDetected: number` alongside `candidates[]` and `judgmentRequired`. It SHALL be the number of distinct middle- and high-band candidate pairs the detection ranked BEFORE `CANDIDATES_PER_SAVE_MAX` was applied. Low-band pairs SHALL NOT be counted. The response reports them as related memories (see "Save responses MUST report low-band pairs as `related[]` and high-band candidates in `convergeWith[]`"), and they create no judgment. Counting them would make `candidatesDetected > candidates.length` stop meaning truncation, and would point the `topic_key` advice below at weak matches. It SHALL be present on every successful save response, whether or not the list was capped, so a caller never has to distinguish "nothing was cut" from "the field was omitted". Existing response fields SHALL be unchanged, and the per-candidate object SHALL NOT gain a field — the count describes the save, not a candidate.

The field SHALL be documented as a LOWER BOUND on how many memories in scope resemble the saved row, never as a scope-wide total, because each detection channel scans a bounded pool before ranking (see the `memory` capability's `CANDIDATE_POOL_SIZE`). It SHALL NOT be named with a `Total` suffix. That suffix is reserved for the true scoped counts this API already ships — `pendingJudgmentsTotal` and the relation-annotation total — and applying it to a floor would teach a caller that a `*Total` in this API may under-report. Equally it SHALL NOT be the returned list's length restated, which is the defect `predecessorCount` exhibits and which carries no information the caller did not already hold.

No companion boolean SHALL be added: truncation is `candidatesDetected > candidates.length`, and a redundant flag beside a number is duplicated state.

`memory.capture_passive` runs the same curation path per extracted learning (see "`memory.capture_passive` MUST use the same curation path as `memory.save`"), so its response SHALL also carry `candidatesDetected` — the SUM over the saves it performed — present on every successful response including one that extracted nothing, where it SHALL be 0. Two write paths through one pipeline SHALL NOT describe that pipeline differently.

When `CANDIDATES_PER_SAVE_MAX` is 0, detection does not run at all, and `candidatesDetected` SHALL be 0. The field reports what detection produced; with surfacing disabled there is nothing to report, and the operator who disabled it is the party reading the number.

Because the count is only actionable if the caller knows what to do with it, the `memory.save` tool description SHALL state:

1. what `candidatesDetected` counts, and that it is a lower bound rather than a total;
2. that only the entries in `candidates[]` carry `judgmentId`s and pending rows, so a high `candidatesDetected` is NOT a queue the agent has just created;
3. that a `candidatesDetected` substantially above the returned count usually means the topic wants converging under one `topic_key` (via `memory.suggest_topic_key`) rather than many separate judgments — the modelling fix, not the symptom;
4. that the unsurfaced remainder is re-derivable with `memory.search` and recordable per pair with `memory.compare`.

The description SHALL NOT name any request argument that raises the surfaced count, because none exists: the bound is the operator setting `CANDIDATES_PER_SAVE_MAX`, and the description SHALL say so. A description that instructs an agent to pass a value the input schema rejects SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it with an invalid-argument error for exactly the queues worth draining.

`candidatesDetected` SHALL NOT change which candidates are surfaced, their order, the rows written, or any input schema. No MCP tool input gains an argument, so no client change is required.

#### Scenario: A truncated save reports the larger number

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and a save whose detection ranks 12 candidates
- **WHEN** `memory.save` returns
- **THEN** the response SHALL carry `candidates` with 5 entries, `judgmentRequired: true`, and `candidatesDetected: 12`

#### Scenario: An untruncated save still carries the field

- **WHEN** a save's detection ranks 2 candidates under a cap of 5
- **THEN** the response SHALL carry `candidates` with 2 entries and `candidatesDetected: 2`

#### Scenario: A save with no candidates reports zero

- **WHEN** a save's detection ranks no candidates
- **THEN** the response SHALL be `{ id, status, createdAt, candidates: [], judgmentRequired: false, candidatesDetected: 0 }`

#### Scenario: No companion truncation flag is returned

- **WHEN** any `memory.save` response is inspected
- **THEN** it SHALL NOT contain a boolean reporting whether the candidate list was truncated; that fact SHALL be derivable as `candidatesDetected > candidates.length`

#### Scenario: Only surfaced candidates create judgeable rows

- **GIVEN** a response carrying 5 candidates and `candidatesDetected: 12`
- **WHEN** the agent closes every `judgmentId` it received
- **THEN** exactly 5 judgments SHALL have existed to close, and no `judgmentId` SHALL exist for the other 7 pairs

#### Scenario: Surfacing disabled reports zero rather than a detected count

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 0`
- **WHEN** `memory.save` returns
- **THEN** the response SHALL carry `candidates: []`, `judgmentRequired: false` and `candidatesDetected: 0`

#### Scenario: `memory.capture_passive` reports the sum across its saves

- **GIVEN** a passive capture that extracts 3 learnings whose detections rank 4, 0 and 7 candidates respectively
- **WHEN** `memory.capture_passive` returns
- **THEN** the response SHALL carry `candidatesDetected: 11`

#### Scenario: `memory.capture_passive` extracting nothing reports zero

- **WHEN** `memory.capture_passive` finds no extractable section and saves nothing
- **THEN** the response SHALL carry `saved: 0` and `candidatesDetected: 0`

#### Scenario: The description teaches the actions and names no rejected ask

- **WHEN** an MCP client retrieves the tool description for `memory.save`
- **THEN** it SHALL state what `candidatesDetected` counts and that it is a lower bound; that only `candidates[]` carries `judgmentId`s; that a high value points at `topic_key` convergence via `memory.suggest_topic_key`; and that the remainder is re-derivable with `memory.search` and recordable with `memory.compare`
- **AND** it SHALL NOT instruct the agent to pass any argument raising the surfaced count, naming `CANDIDATES_PER_SAVE_MAX` as an operator setting instead

#### Scenario: The description stays under the client truncation ceiling

- **WHEN** the `memory.save` description is measured after the addition
- **THEN** its length SHALL remain below `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: The field does not alter save behaviour

- **GIVEN** two identical saves against identical corpora, one on a build carrying the field and one on a build without it
- **WHEN** both complete
- **THEN** both SHALL return the same `candidates[]` in the same order and SHALL have written the same number of pending `memory_relations` rows

#### Scenario: Low-band pairs are not counted

- **GIVEN** a save whose detection ranks one middle-band pair and one low-band pair
- **WHEN** `memory.save` returns
- **THEN** the response SHALL carry one entry in `candidates`, one in `related`, and `candidatesDetected: 1`

## ADDED Requirements

### Requirement: Save responses MUST report low-band pairs as `related[]` and high-band candidates in `convergeWith[]`

Save-time pairs are classified into confidence bands (see the `memory` capability, "Save-time candidates MUST be classified into confidence bands by one shared function"). The bands SHALL be visible in the response, so the agent knows which pairs to judge, which to converge, and which only to read.

`memory.save` and a committed `memory.merge` SHALL return two arrays beside `candidates[]`:

- **`related: Array<RelatedMemory>`** holds the low-band pairs. `RelatedMemory` is the `Candidate` shape without `judgmentId`: `targetId`, `title`, `snippet`, `similarity`, `source`, `topicKey`, and `entityValue` for an entity-sourced pair. The pairs SHALL be in the detection's ranked order, at most `CANDIDATES_PER_SAVE_MAX` of them. No pending row exists for them, and nothing about them needs judging.
- **`convergeWith: string[]`** holds the `judgmentId`s of the high-band entries of `candidates[]`: pairs similar enough in meaning that the two memories likely state the same fact. Each id SHALL name exactly one `candidates[]` entry, and the agent maps it to that entry. A judgment id names the pair, not just the target, so it stays unambiguous when several learnings of one `memory.capture_passive` resemble the same memory. Each such entry SHALL keep its `judgmentId` and pending row.

The convergence steer SHALL be advisory. A high-band pair can still be related rather than the same fact, so the agent decides, and the pending row survives whatever it decides. Neither the response nor a description SHALL present `convergeWith[]` as a verdict.

Both arrays SHALL be present on every successful `memory.save` response and on every `memory.merge` commit, empty when nothing qualifies. A `memory.merge` preview SHALL carry neither, as it carries no `candidates`. `judgmentRequired` SHALL remain `candidates.length > 0`. The `Candidate` object SHALL NOT gain a field.

`memory.capture_passive` runs the same curation path per learning (see "`memory.capture_passive` MUST use the same curation path as `memory.save`"). It SHALL therefore concatenate both arrays across the learnings it saved, exactly as it concatenates `candidates[]`. It SHALL include each array under the same rule it applies to `candidates[]`: present when non-empty. Two write paths through one pipeline SHALL NOT describe the bands differently.

Every tool returning the arrays SHALL declare them in its `outputSchema`.

The `memory.save` description SHALL state:

1. that `related[]` entries carry no `judgmentId` and need no judgment;
2. that `convergeWith[]` holds the `judgmentId`s of candidates that likely restate the saved fact, and that the steer is advisory;
3. what to do with them: `memory.merge`, or a `supersedes` verdict with the target's `topic_key` reused.

The `memory.capture_passive` description SHALL name both arrays and refer to `memory.save` for their meaning. Both obligations SHALL be satisfied within `DESCRIPTION_MAX_LENGTH`. The clauses reclaimed to fit them SHALL be named by the change that removes them.

#### Scenario: A low-band pair is related and carries no judgment id

- **GIVEN** an existing memory whose pair with the just-saved row is low-band
- **WHEN** `memory.save` returns
- **THEN** `related` SHALL contain an entry for it without a `judgmentId`, `candidates` SHALL NOT contain it, and no pending row SHALL exist for the pair

#### Scenario: A high-band pair is a candidate and a convergence suggestion

- **GIVEN** an existing memory whose pair with the just-saved row is high-band
- **WHEN** `memory.save` returns
- **THEN** `candidates` SHALL contain it with a `judgmentId` backed by a pending row, `convergeWith` SHALL contain that `judgmentId`, and `judgmentRequired` SHALL be `true`

#### Scenario: Both arrays are present when empty

- **WHEN** a `memory.save` finds no pair
- **THEN** the response SHALL carry `related: []` and `convergeWith: []`

#### Scenario: A merge commit reports the bands as `memory.save` does

- **GIVEN** a committed `memory.merge` whose successor pairs low-band with one memory and high-band with another
- **WHEN** the commit returns
- **THEN** `related`, `convergeWith`, `candidates` and `candidatesDetected` SHALL follow the same rules as a `memory.save` of the same successor

#### Scenario: A passive capture aggregates the bands and omits empty arrays

- **GIVEN** a passive capture whose first learning pairs low-band with one memory and high-band with another
- **WHEN** `memory.capture_passive` returns
- **THEN** `related` and `convergeWith` SHALL report those pairs as `memory.save` would
- **AND** a capture whose learnings pair with nothing SHALL carry none of `candidates`, `related` or `convergeWith`

#### Scenario: Two learnings near one memory stay distinct in `convergeWith`

- **GIVEN** a passive capture whose two learnings each pair high-band with the same existing memory
- **WHEN** `memory.capture_passive` returns
- **THEN** `convergeWith` SHALL hold two distinct ids, each naming exactly one `candidates[]` entry for that memory

#### Scenario: The description teaches the two arrays within the cap

- **WHEN** an MCP client reads the `memory.save` description from a real `tools/list` response
- **THEN** it SHALL name `related[]` as matches with nothing to judge and `convergeWith[]` as the advisory `judgmentId`s of likely restatements to converge with `memory.merge` or a `supersedes` verdict
- **AND** its length SHALL remain at most `DESCRIPTION_MAX_LENGTH`
