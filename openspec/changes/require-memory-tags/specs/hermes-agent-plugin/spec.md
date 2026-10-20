## ADDED Requirements

### Requirement: Hermes SAVE guidance MUST teach required memory tags

The SAVE clause of `system_prompt_block` SHALL include required `tags` alongside `title` and `content`, teaching normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`. This scoped requirement supplements the SAVE clause in "Provider lifecycle method behavior": its `title` plus `content` wording is not an exhaustive input schema and SHALL NOT be interpreted as permitting tagless operational saves.

The block SHALL remain byte-identical to the server's `initialize.instructions` BASE and within the existing 1000-character cap. All existing RECALL, SUMMARIZE, session-id, and update guidance obligations remain in effect. `topic_key` SHALL remain optional. Choosing tags SHALL NOT require another tool/call, a catalog, or an alias lookup. No lifecycle, installer, distribution, or release behavior changes are required.

#### Scenario: Hermes guidance matches the server and teaches labels

- **WHEN** the provider's system prompt block and server BASE guidance are compared
- **THEN** they SHALL be byte-identical, include required memory tags and the normally 1–5 reusable lowercase kebab-case guidance, and fit within 1000 characters
- **AND** existing protocol-flow assertions SHALL still pass without new calls or expanded recall payloads
