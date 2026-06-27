# memory delta — unified Unicode-aware FTS builder and scoped batch retrieve

## MODIFIED Requirements

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always) and vec kNN neighbors (when the just-saved row has an embedding), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates ordered by max(vec, fts) score descending.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each exceed the internal vec threshold against the just-saved row N
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: The just-saved row has no embedding

- **GIVEN** the inline embedding of the just-saved row failed (logged, drain will retry)
- **WHEN** `memory.save` runs candidate detection
- **THEN** only FTS5-derived candidates SHALL be considered; each candidate in the response SHALL carry `source: 'fts'`

#### Scenario: Candidate count exceeds the cap

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and 12 candidates exceed the thresholds
- **WHEN** `memory.save` returns
- **THEN** the response SHALL include the top 5 by score; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `(scope, project_id)` SHALL match `project:'A'`; rows in other projects or in global SHALL NOT be considered, regardless of similarity

#### Scenario: A non-ASCII save participates in the lexical pass

- **GIVEN** an existing active memory whose content is non-ASCII (e.g. CJK or accented text) in scope `project:'A'`, and a just-saved row N in the same scope whose content lexically overlaps it
- **WHEN** `memory.save` runs candidate detection
- **THEN** the FTS5 `MATCH` expression built from N's content SHALL be non-empty (it SHALL NOT degrade to skipping the lexical pass), and the overlapping memory SHALL be eligible to surface as a `source: 'fts'` candidate when it clears the FTS threshold

## ADDED Requirements

### Requirement: A scope-enforced batch retrieve MUST back the batch `memory.get`

The service layer SHALL expose a scoped batch retrieve that returns multiple memories by id while preserving scope isolation. The batch retrieve SHALL accept a list of ids and a resolved scope, and SHALL return only the memories whose `(scope, project_id)` matches the given scope, in the same order as the requested ids; ids that are missing OR outside the given scope SHALL be omitted from the result, and the caller SHALL NOT be able to distinguish "missing" from "out of scope" (closing the same information-leak channel as single-memory `get`). The underlying cross-scope primitive (`unsafeGetByIds`) SHALL remain internal and SHALL NOT be callable from the MCP handler directly; only the scoped batch read SHALL be exposed to MCP.

#### Scenario: Batch retrieve returns in-scope rows in request order

- **GIVEN** in-scope active memories M1, M2, M3 in scope `project:'A'`
- **WHEN** the scoped batch retrieve is called with `['M3', 'M1', 'M2']` and scope `project:'A'`
- **THEN** it SHALL return the three memories in the order `[M3, M1, M2]`

#### Scenario: Batch retrieve drops cross-scope ids without leaking

- **GIVEN** memory X in scope `project:'B'` and memory M1 in scope `project:'A'`
- **WHEN** the scoped batch retrieve is called with `['M1', 'X']` and scope `project:'A'`
- **THEN** the result SHALL contain only M1; X SHALL be absent, with no error or field that reveals X exists in another scope

#### Scenario: Batch retrieve with no resolvable ids returns empty

- **WHEN** the scoped batch retrieve is called with ids that are all missing or all out of scope
- **THEN** it SHALL return an empty list, not an error
