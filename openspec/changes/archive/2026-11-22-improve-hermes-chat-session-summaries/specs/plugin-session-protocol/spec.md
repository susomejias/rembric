## ADDED Requirements

### Requirement: Conversational reminder acceptance MUST distinguish delivery from curated convergence

Conversational eligibility SHALL reuse the shared server gate and notice on all five clients and generic turn reporters; the expanded policy SHALL NOT be described as Hermes-only. Clients SHALL keep reporting their actual observation and printing returned lines without local cadence or curation state.

Deterministic acceptance SHALL separately prove server eligibility/floor, client delivery and RAW/curated precedence. RAW fallback SHALL remain non-final and SHALL NOT replace already curated summary/title fields. A delivered notice SHALL NOT be counted as a successful curated write. Actual Hermes gateway/model acceptance SHALL demonstrate a successful `memory.session_summary` call against the correctly registered explicit session ID and the resulting stored curated fields, with a later RAW write unable to displace them. An unavailable deployment, missing supported hooks or an uncooperative model SHALL be recorded as pending acceptance, not a passed end-to-end result. No forced continuation loop SHALL be introduced to obtain compliance.

#### Scenario: Shared policy reaches chat-only reporters without client-specific exceptions

- **GIVEN** equivalent active-session state for each bundled client
- **WHEN** each reports a completed conversational turn after the floor
- **THEN** the shared server SHALL apply identical eligibility and notice composition regardless of client
- **AND** client adapters SHALL print returned lines through their existing surfaces

#### Scenario: RAW fallback cannot overwrite curated conversation state

- **GIVEN** a successful model-authored curated summary and title
- **WHEN** Hermes later sends per-turn or lifecycle RAW transcript/title fields with `final:false`
- **THEN** stored curated fields SHALL remain unchanged
- **AND** the RAW request SHALL NOT count as another curated write

#### Scenario: Mocked delivery does not close gateway acceptance

- **GIVEN** deterministic server and provider tests pass but no actual gateway/model run is available
- **WHEN** the implementation evidence is reported
- **THEN** server/provider behavior SHALL be listed as verified separately from pending gateway/model acceptance
- **AND** neither universal curated convergence nor resolution of the deployed empty-session report SHALL be claimed
