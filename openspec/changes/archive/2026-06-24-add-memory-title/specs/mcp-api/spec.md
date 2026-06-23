## MODIFIED Requirements

### Requirement: memory.save MUST accept a `topic_key` and surface candidates

The `memory.save` tool's input schema SHALL require a `title: string` argument (1–100 chars; empty or over-long rejected with `invalid_input`) and SHALL gain an optional `topic_key?: string` argument (max length 128, NUL-byte rejected). The response shape SHALL be extended with two additional fields: `candidates: Array<Candidate>` (always present, empty when none found) and `judgmentRequired: boolean`. Existing fields (`id`, `status`, `createdAt`) are unchanged.

The `Candidate` type:

```ts
{
  judgmentId: string;
  targetId: string;
  title: string; // the candidate's title
  snippet: string; // first ~200 chars of the candidate's content
  similarity: number; // 0..1, max(vec, fts) normalized
  source: 'vec' | 'fts'; // which detector surfaced it
}
```

#### Scenario: memory.save with no `topic_key` and zero candidates

- **WHEN** `memory.save({type, title, content})` is called and no existing memory matches the candidate-detection thresholds
- **THEN** the response SHALL be `{ id, status: 'active', createdAt, candidates: [], judgmentRequired: false }`

#### Scenario: memory.save without a title

- **WHEN** `memory.save` is called without a `title`, or with a `title` that is empty or longer than 100 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

#### Scenario: memory.save with `topic_key` upserting an existing row

- **WHEN** `memory.save({type, title, content, topic_key: 'arch/auth'})` is called and an active memory with that key exists in scope
- **THEN** the response SHALL include the newly created `id`; the previous row SHALL be in `status = 'superseded'`; `candidates` MAY additionally include unrelated rows surfaced by FTS/vec; `judgmentRequired` reflects only the candidates surfaced via that path, not the topic-key upsert (which is already judged)

#### Scenario: memory.save before the just-saved row has an embedding

- **GIVEN** the just-saved row's embedding has not been computed yet (lazy model load or worker lag)
- **WHEN** `memory.save` finds three FTS5 matches above threshold
- **THEN** the response SHALL include three candidates each with `source: 'fts'` and each carrying the candidate's `title`; no vec-sourced candidates SHALL appear

#### Scenario: memory.save with `topic_key` longer than 128 chars

- **WHEN** the input `topic_key` exceeds 128 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

## ADDED Requirements

### Requirement: Memory-returning MCP reads MUST expose the title

Every MCP tool that returns a memory SHALL include that memory's `title` field in the returned shape: `memory.search` result rows, `memory.get` (the memory object, its `head`, and each `predecessors[]` entry), `memory.timeline` neighbors (`before[]`/`after[]`), and `memory.context` (`recentMemories[]`, plus a source/target title on `pendingJudgments[]`, and `needsReview[]`). The title SHALL be returned in full (titles are capped at 100 chars, so no snippet truncation applies).

#### Scenario: memory.search rows carry a title

- **WHEN** `memory.search` returns one or more memory rows
- **THEN** each returned row SHALL include its `title`

#### Scenario: memory.context surfaces titles

- **WHEN** `memory.context` returns `recentMemories`, `pendingJudgments`, or `needsReview` entries
- **THEN** each `recentMemories`/`needsReview` entry SHALL include its memory's `title`, and each `pendingJudgments` entry SHALL include the source and target memories' titles

#### Scenario: memory.timeline neighbors carry a title

- **WHEN** `memory.timeline` returns `before` or `after` neighbors
- **THEN** each neighbor SHALL include its `title`
