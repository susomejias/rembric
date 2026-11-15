# file-anchored-recall Specification

## Purpose

TBD - created by archiving change file-anchored-recall. Update Purpose after archive.

## Requirements

### Requirement: The server MUST return memories linked to a file the agent is about to work on

The service SHALL look up the session's project for memories linked to one repo-relative file path. It SHALL return at most `FILE_RECALL_PER_FILE_MAX` (3) of them as notice lines.

The project SHALL be the session's own project, resolved at the service layer. A session with no project, an unknown session, an empty path or a path that is not repo-relative SHALL yield no lines. A repo-relative path is one that is not absolute, has no `..` segment and has no leading `./` once normalised.

Only memories that are `status = 'active'` AND of a type in `project`, `feedback` or `procedural` SHALL be eligible. These are the active-learning types prompt-time recall already uses. A memory whose `session_id` equals the calling session SHALL NOT be returned, because the agent saved it in this conversation and already knows it.

The path SHALL be normalised the way `path` entities are stored: `\` becomes `/`, repeated `/` collapse and a leading `./` is removed. Nothing in this lookup SHALL write a memory row.

#### Scenario: A memory linked to the file is returned

- **GIVEN** an active `project` memory M in project `foo` whose content mentions `packages/db/src/migrate.ts`, saved by a different session
- **WHEN** session S in project `foo` asks for file recall on `packages/db/src/migrate.ts`
- **THEN** the response SHALL contain one line naming M's title and id

#### Scenario: Ineligible memories are not returned

- **GIVEN** memories linked to the same path that are, respectively, `archived`, of type `reference`, and saved by session S itself
- **WHEN** session S asks for file recall on that path
- **THEN** none of them SHALL be returned
- **AND** the control SHALL pass in the same run: an otherwise identical active `project` memory saved by another session IS returned

#### Scenario: A path outside the repository is ignored

- **WHEN** a client sends `/etc/hosts`, `../other/file.ts` or an empty path
- **THEN** the response SHALL carry no lines and SHALL NOT be an error

### Requirement: A shorter suffix of the path MUST match only when no other tracked file shares it

Memories often name a file by a partial path, such as `services/review.ts`. Besides the exact repo-relative path, the service SHALL try every proper suffix of it that has at least two segments. A suffix SHALL be tried only when exactly one entry of the request's `siblings` ends with it at a segment boundary, and that entry is the requested path itself.

`siblings` SHALL be the repository's tracked paths that share the requested file name, as the client reported them. When `siblings` is absent or empty, only the exact path SHALL be tried. A bare file name, a one-segment suffix, SHALL never be tried.

The lookup SHALL be a single query over the candidate values, so it stays on the entity identity index.

#### Scenario: A unique two-segment suffix matches

- **GIVEN** a memory whose only path entity is `services/review.ts`
- **AND** a request for `packages/core/src/services/review.ts` whose `siblings` are `["packages/core/src/services/review.ts"]`
- **WHEN** file recall runs
- **THEN** the memory SHALL be returned

#### Scenario: A shared suffix does not match

- **GIVEN** a memory whose only path entity is `mcp-api/spec.md`
- **AND** a request for `openspec/changes/x/specs/mcp-api/spec.md` whose `siblings` include `openspec/specs/mcp-api/spec.md` as well
- **WHEN** file recall runs
- **THEN** the memory SHALL NOT be returned, because `mcp-api/spec.md` names more than one tracked file
- **AND** the control SHALL pass in the same run: with `siblings` naming only the requested path, the memory IS returned

#### Scenario: Without siblings only the exact path matches

- **WHEN** a request for `packages/core/src/services/review.ts` carries no `siblings`
- **THEN** only memories linked to exactly `packages/core/src/services/review.ts` SHALL be returned

### Requirement: File recall MUST rank the most specific memories first and bound its output

Eligible memories SHALL be ordered by the number of `path` entities linked to each memory, ascending, then by `created_at` descending, then by `id` descending. A memory that names few files is more likely to be about this one.

The response SHALL render at most `FILE_RECALL_PER_FILE_MAX` (3) memories as one block:

- a header line `rembric: memories about <path>:`;
- one line per memory, `- <title> [<id>] (<YYYY-MM-DD of created_at>)`, with `, needs review` appended inside the parentheses when the memory's derived review state is `needs_review`;
- for the FIRST memory only, a second line holding a window of at most `FILE_RECALL_WINDOW_CHARS` (300) characters of its content around the first mention of the file name, whitespace collapsed, prefixed and suffixed with `…` where cut.

The whole block SHALL NOT exceed `FILE_RECALL_MAX_BYTES` (1024) UTF-8 bytes. When it would, the window SHALL be shortened first and trailing memory lines dropped next, never cutting inside a UTF-8 sequence or a surrogate pair.

The window SHALL pass through the same secret redaction the save path applies before it is cut. Rows written before redaction-on-write existed are not guaranteed to be clean, and a cut must never leave half a secret undetectable.

#### Scenario: The most specific memory comes first and carries the window

- **GIVEN** memory A linked to 1 path and memory B linked to 12 paths, both linked to the requested file, B newer than A
- **WHEN** file recall runs
- **THEN** A's line SHALL come before B's
- **AND** only A SHALL be followed by a content window

#### Scenario: The block never exceeds its byte bound

- **GIVEN** three eligible memories with 100-character titles and long content
- **WHEN** file recall runs
- **THEN** the returned block SHALL be at most 1024 UTF-8 bytes
- **AND** it SHALL still begin with the header line and the first memory's line

#### Scenario: A stale memory is marked

- **GIVEN** an eligible memory whose review state is `needs_review`
- **WHEN** it is rendered
- **THEN** its line SHALL end with `(<date>, needs review)`

### Requirement: File recall MUST be deduped and capped per session

The service SHALL keep per-session state of the memory ids it has already returned. A memory already returned to a session SHALL NOT be returned to it again. A file whose eligible memories have all been returned SHALL yield no lines.

At most `FILE_RECALL_FILES_PER_SESSION` (10) requests in a session SHALL produce lines. Once that many have, every later request SHALL return no lines and `exhausted: true`. A client that sees `exhausted: true` SHALL stop calling the endpoint for that session.

The state SHALL be bounded the way prompt-time recall's dedupe state is, as an LRU over at most 500 sessions. It SHALL be released when the session is ended, soft-deleted or resumed. Resuming is what every post-compaction path already does, so a conversation that lost its context to compaction can receive the same memories again.

#### Scenario: A memory is returned once per session

- **GIVEN** memory M linked to both `a.ts` and `lib/b.ts`
- **WHEN** session S asks for `a.ts` and then for `lib/b.ts`
- **THEN** M SHALL appear only in the first response

#### Scenario: The per-session cap stops further calls

- **GIVEN** session S has already received lines for 10 files
- **WHEN** it asks for an eleventh file that has eligible memories
- **THEN** the response SHALL carry no lines and `exhausted: true`

#### Scenario: Resume releases the state

- **GIVEN** session S already received memory M
- **WHEN** the session is resumed (`POST /api/<slug>/sessions/<S>/resume`) and S asks for M's file again
- **THEN** M SHALL be returned again

### Requirement: File recall MUST be cheap, fail open and be counted

The lookup SHALL issue one entity query per request, plus one bounded read of the linked memories. It SHALL NOT embed, rank with the hybrid search, or touch `last_seen_at`. Returning a memory as a notice is not a read by the agent.

Any failure inside the service SHALL be reported as an error response, never as a partial block. Clients treat every non-2xx response as "no notes".

The server SHALL count each request and the number of lines served per token, alongside the existing recall counter, so the cost per session can be measured.

#### Scenario: A notice does not count as a read

- **GIVEN** memory M with `last_seen_at = T`
- **WHEN** M is returned by file recall
- **THEN** M's `last_seen_at` SHALL still be `T`

#### Scenario: Firings are counted

- **WHEN** a token makes three file-recall requests that return 2, 0 and 1 lines
- **THEN** that token's file-recall counter SHALL record 3 firings and 3 lines
