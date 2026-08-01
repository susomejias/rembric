## MODIFIED Requirements

### Requirement: The MCP server MUST expose `memory.suggest_topic_key`

The server SHALL register a `memory.suggest_topic_key` tool that returns a stable topic key heuristic from `type` plus optional `title` / `content`. The implementation SHALL be deterministic (no LLM call) and family-aware, with one family per `type`: `preference/*` for `user`, `feedback/*` for `feedback`, `decision/*` for `project`, `reference/*` for `reference`, `runbook/*` for `procedural`. No other `type` is accepted — the tool's schema is `z.enum(MEMORY_TYPES)`.

The slug SHALL be derived by TRANSLITERATING the title rather than stripping it: a character outside `[a-z0-9-]` SHALL be mapped to its closest ASCII equivalent where one exists (Latin diacritics, `ß`, `ø`, `æ`, Cyrillic, Greek), so a non-ASCII word yields one token rather than fragmenting into several. Stripping non-ASCII characters to whitespace is specifically forbidden: it splits words and each fragment then consumes one of the bounded token slots, truncating the slug before the terms that identify the topic.

Function words SHALL be filtered before the token budget is applied, and the filtered set SHALL NOT be limited to English — a non-English title whose particles survive spends its budget on them and loses its discriminating terms.

When the title and content together yield no usable slug — which is the case for scripts no transliteration table covers, notably CJK and Hangul — the tool SHALL return `topic_key: null` together with a `reason` naming why, and SHALL NOT invent a placeholder. Emitting a constant such as `<family>/untitled`, or a slug reduced to an incidental number, is forbidden: distinct memories would receive the same suggestion, and an agent adopting it would drive the `topic_key` upsert to supersede an unrelated active row. A caller may still author its own key, which the server accepts as Unicode.

#### Scenario: A suggestion is requested for a clear case

- **WHEN** `memory.suggest_topic_key({type: 'project', title: 'JWT auth middleware'})` is called
- **THEN** the response SHALL carry a non-null `topic_key` in the `decision/` family derived from the title's non-stopword keywords

#### Scenario: A suggestion is requested without a title

- **WHEN** `memory.suggest_topic_key({type: 'project', content: 'long free-form text...'})` is called
- **THEN** the heuristic SHALL fall back to a content-derived slug (first non-stopword keywords), prefixed with the type family

#### Scenario: A type outside the memory-type enum is rejected

- **WHEN** `memory.suggest_topic_key` is called with a `type` that is not one of `MEMORY_TYPES`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: An accented title keeps its words whole

- **WHEN** a title containing accented Latin characters is passed (e.g. Spanish `admisión`, German `Größe`)
- **THEN** each such word SHALL appear in the slug as one transliterated token, and SHALL NOT be split at the accented character

#### Scenario: A non-English title reaches its discriminating terms

- **WHEN** a Spanish title is passed whose leading words are articles and prepositions
- **THEN** those particles SHALL be absent from the slug, and the slug SHALL contain the title's content words rather than stopping among the particles

#### Scenario: A title in a script with no transliteration yields no suggestion

- **WHEN** a title consisting of Hangul or CJK characters with no ASCII content is passed
- **THEN** the response SHALL carry `topic_key: null` and a non-empty `reason`, and SHALL NOT carry a placeholder slug

#### Scenario: The same input is provided twice

- **WHEN** identical arguments are passed in two separate calls
- **THEN** the returned `topic_key` SHALL be byte-identical (determinism)
