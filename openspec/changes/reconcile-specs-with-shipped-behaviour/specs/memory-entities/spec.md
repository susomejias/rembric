## MODIFIED Requirements

### Requirement: Entity extraction MUST be deterministic and MUST NOT use a model

Entities SHALL be extracted from a memory's `title + content` by a pure function with no inference, no model, and no network call, so extraction is reproducible, auditable, and free. Only entity kinds recognisable from syntax with high confidence SHALL be extracted: file paths, git refs, error codes, URLs, ticket-style identifiers, CVE ids, IPv4 addresses, self-hosted hostnames, systemd units, MAC addresses, environment variables, and UUIDs.

A kind SHALL be admitted only when its syntax is closed enough to reject prose without a denylist of English words. Kinds whose shape cannot be bounded that way — symbol identifiers, package names, semver strings, Docker image references, cron expressions — SHALL remain deliberately unsupported until a measured precision case exists for them.

An identifier class whose shape it shares with another class SHALL be separated by an anchor or a closed list, never by pattern order. Specifically: a token in `SCREAMING_SNAKE_CASE` SHALL NOT be typed on shape alone — it is indistinguishable between an error code, an environment variable and an ordinary constant — so `error_code` SHALL match only prefixed families (`ERR_`, `SQLITE_`, `E_`) plus closed name lists, and `env_var` SHALL require a `$`, `${}` or `=` anchor.

#### Scenario: An unanchored SCREAMING_SNAKE token is not typed

- **WHEN** a memory's content reads "export DATABASE_URL before starting"
- **THEN** no entity SHALL be linked for that token

#### Scenario: An anchored environment variable is typed

- **WHEN** a memory's content contains `NODE_ENV=production` or `$DATABASE_URL`
- **THEN** an entity of kind `env_var` SHALL be linked, carrying the bare name

#### Scenario: A UUID does not yield a git ref

- **WHEN** a memory's content contains `550e8400-e29b-41d4-a716-446655440000`
- **THEN** an entity of kind `uuid` SHALL be linked and no `git_ref` SHALL be linked for its segments

Extraction and linking SHALL run **immediately after the save commits**, best-effort, and an extraction failure SHALL NOT fail the save — the memory is the primary record and the index is derived. They are deliberately NOT inside the save transaction: the save path computes the row's embedding between the commit and the linking, and holding a write transaction open across that would serialise every concurrent save behind one model call for the sake of an index that is rebuildable by construction. A memory whose linking never ran is indistinguishable from one the backfill has not reached yet, and the same resumable drain corrects both.

Prose that merely resembles an entity SHALL NOT be extracted: precision is preferred over recall, because a false entity link pollutes exact-address lookup, which is the mechanism's whole value.

#### Scenario: A file path in memory content is extracted

- **WHEN** a memory is saved whose content references `apps/server/src/db/migrate.ts`
- **THEN** an entity of kind `path` SHALL be linked to that memory

#### Scenario: Extraction is reproducible

- **WHEN** the extractor runs twice over identical text
- **THEN** it SHALL produce an identical set of entities

#### Scenario: An extraction failure does not fail the save

- **WHEN** extraction or linking throws for a given memory
- **THEN** the memory SHALL still be saved, the failure SHALL be logged, and the row SHALL remain visible to the backfill drain

#### Scenario: Ordinary prose does not produce entities

- **WHEN** a memory is saved whose content is prose containing no path, ref, identifier, URL, or ticket id
- **THEN** no entity SHALL be linked to it

### Requirement: A kind MUST earn its place against the lexical branch, not merely be plausible

The lexical branch already resolves some identifier classes exactly: `sanitizeFtsQuery` quotes each whitespace-delimited token as an FTS5 phrase, and FTS5's `unicode61` tokenizer drops `/`, `.`, `_`, `#` and `-`. An identifier whose tokens the tokenizer preserves as a phrase that cannot occur inside a longer valid identifier of the same class, and cannot occur as ordinary prose, is therefore already retrieved without false positives. Adding a kind for such an identifier buys enumeration, not precision, and the distinction SHALL be recorded rather than assumed.

A kind SHALL be justified by one of: (a) a measured false-positive rate through the lexical branch, (b) removal of an existing false extraction, or (c) an enumeration or typed-projection capability the lexical branch structurally cannot provide.

The measurement SHALL exist as a committed, runnable artifact, not as prose. A published figure without a reproducible measurement behind it is indistinguishable from a guess, and the previous table contained one that was wrong in both directions: `error_code` was credited 0% as "self-terminating under tokenization" for the whole kind, when its closed gRPC name list measures 50% (the tokenizer drops `_` exactly as it drops the `.` the table penalised `hostname` for, so `NOT_FOUND` is the phrase "not found" and matches ordinary prose), while `hostname` was under-reported at 50% against a measured 67%.

The apparatus SHALL therefore be: an adversarial corpus committed alongside the code, a measurement that runs the REAL lexical path (`sanitizeFtsQuery` into the production BM25 read over a live FTS5 index), and a test asserting each published figure so the table cannot drift from the measurement and a new kind cannot be added on prose alone. Each probe declares one identifier, one document that genuinely references it, and decoy documents that do not — and every decoy SHALL be admissible under exactly one of the two mechanisms the lexical branch actually exhibits: a **near-miss identifier** (a different valid identifier of the same class whose token phrase contains the target's), or a **tokenization collision** (ordinary prose reachable only because the tokenizer dropped the separator that made the target an identifier). Without that rule any figure could be inflated by writing more prose. Figures are reported as the WORST case across a kind's probes, because the corpus is adversarial and a mean would let a benign probe dilute a real collision.

Measured against that corpus:

| kind                                        | justification            | measured worst-case lexical noise                                                                                 |
| ------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `path`                                      | precision                | 67% — a path is a prefix (`.bak`) and a suffix (`test/…`) of other valid paths                                     |
| `hostname`                                  | precision                | 67% — the dot is dropped, so `nas.local` matches "the nas local drive" and `backup-nas.local`                      |
| `env_var`                                   | precision                | 67% — the underscore is dropped, so `DATABASE_URL` matches the prose "database url" and `DATABASE_URL_REPLICA`     |
| `ticket`                                    | precision                | 50% — the `#` is dropped, so `#36` matches "36 files"; `PROJ-1234` is a phrase prefix of `PROJ-1234-B`             |
| `ip_address`                                | precision                | 50% — an address is a phrase prefix of a longer dotted string                                                      |
| `systemd_unit`                              | precision                | 50% — the dot is dropped, so `caddy.service` matches "the caddy service"; the suffix set is reduced (see below)    |
| `error_code` — `GRPC_STATUS_NAMES`          | precision                | 50% — the underscore is dropped, so `NOT_FOUND` and `PERMISSION_DENIED` are ordinary two-word prose                |
| `error_code` — `ERR_`/`SQLITE_`/`E_`/errno  | fixes a false extraction | 0% — prefixed and errno names have no prose form and no shorter valid sibling; the kind's value here is that unanchored `SCREAMING_SNAKE` was typed `error_code`, so `DATABASE_URL` and `MAX_RETRIES` polluted the error index |
| `uuid`                                      | fixes a false extraction | 0% — a UUID's first group satisfied the git-SHA shape, yielding a bogus `git_ref`                                  |
| `cve_id`                                    | fixes a false extraction | 0% — `CVE-2024-3094` yielded a bogus `ticket` of `CVE-2024`                                                        |
| `mac_address`                               | enumeration              | 0% — the lexical branch cannot enumerate devices                                                                   |
| `git_ref`, `url`                            | enumeration              | 0% — these are self-terminating under tokenization                                                                 |

A kind measuring 0% is not thereby unjustified: it may still earn its place under (b) or (c), and the table names which clause each kind rests on.

A kind's pattern MAY be narrower than the identifier class it names when the excluded shapes collide with ordinary prose. `systemd_unit` omits `.target`, `.path`, `.slice`, `.scope` and `.mount` for this reason: they are also everyday property accessors (`event.target`, `array.slice`, `req.path`, `wrapper.mount`), measuring 8 false positives across 9 lines of ordinary code prose versus 1 with the reduced set.

The runtime cost of the index SHALL stay negligible against the vector index it sits beside; at introduction it measured 0.05% of memory-related storage and under 2ms per memory to extract and index. Extraction SHALL stay linear in input length: the patterns are applied to a truncated slice, and a pattern whose label group backtracks quadratically has blocked the single-threaded event loop for 19 seconds on one save, so the linearity SHALL be held by a test with a budget far below any hang guard.

#### Scenario: Every published figure is measured

- **WHEN** the noise-rate measurement runs over the committed corpus
- **THEN** each kind's measured worst-case rate SHALL equal the figure published in this table

#### Scenario: A new kind cannot be published without a probe

- **WHEN** a new entity kind is declared without a probe in the adversarial corpus
- **THEN** the measurement suite SHALL fail, naming the kind

#### Scenario: A probe's truth document is retrievable

- **WHEN** a probe is measured
- **THEN** the lexical branch SHALL return the document that genuinely references the identifier, so a broken query is never reported as a noisy class

#### Scenario: Extraction stays linear on an adversarial label run

- **WHEN** `extractEntities` runs over 200KB of repeated dot-separated single-character labels
- **THEN** it SHALL complete in well under 50ms

#### Scenario: A CVE id does not also yield a ticket entity

- **WHEN** a memory referencing `CVE-2024-3094` is saved
- **THEN** an entity of kind `cve_id` SHALL be linked, and no entity of kind `ticket` SHALL be linked for the same text

#### Scenario: A hostname is not extracted from prose that merely contains its labels

- **WHEN** a memory's content reads "the nas local drive is full"
- **THEN** no entity of kind `hostname` SHALL be linked

#### Scenario: An out-of-range dotted quad is not an address

- **WHEN** a memory's content contains `999.1.1.1`
- **THEN** no entity of kind `ip_address` SHALL be linked

### Requirement: Entities MUST be scoped, and entity lookup MUST respect scope isolation

Each entity SHALL be scoped exactly as memories are — global, or belonging to one project. The identity of an entity is `(scope, project_id, kind, value)`, enforced by a unique index, so the same literal string in two projects is two distinct entities and no join between them exists to be exploited. Retrieval by entity SHALL return only memories the caller's scope permits, and SHALL never return a memory from a different project. An entity string appearing in two projects SHALL NOT join their memories.

A project-scoped read MAY be widened to also include GLOBAL entities, and only global ones: the widening SHALL admit `(global, NULL)` alongside the caller's own `(project, id)` and SHALL never admit a third project's rows. This mirrors the widening the ranked branches already implement for `include_global`, and it is the difference between an agent seeing a user-wide convention about a file and silently not seeing it.

#### Scenario: The same path in two projects does not join them

- **GIVEN** memories in project A and project B both referencing `src/index.ts`
- **WHEN** entity retrieval is performed on a connection scoped to project A
- **THEN** only project A's memories SHALL be returned

#### Scenario: Global entities are available to a project-scoped read when requested

- **GIVEN** a global memory referencing `src/shared.ts` and a project memory referencing the same path
- **WHEN** entity retrieval is performed in the project scope including globals
- **THEN** both SHALL be returned, each labelled with its scope

#### Scenario: Widening to globals does not widen to other projects

- **GIVEN** a third project's memory referencing the same path
- **WHEN** entity retrieval is performed in project A's scope including globals
- **THEN** the third project's memory SHALL NOT be returned

### Requirement: Retrieval by entity MUST bypass ranking

Exact-address retrieval is not a relevance problem: the caller has supplied an exact key. Retrieval by entity SHALL be an index lookup returning the linked memories in the requested scope, ordered chronologically, with no fusion, no rank window, no similarity threshold, and no post-fusion boost. It SHALL be complete within the scope up to an explicit, generous bound — a memory linked to the entity SHALL NOT be omitted because of a RANKING cutoff, and an omitted `limit` SHALL NOT be interpreted as the ranked branches' small default page. The bound SHALL be the same over-fetch ceiling those branches already use, so "complete" means "every linked memory, up to a stated cap far above any realistic per-entity link count" rather than "everything, unbounded" — an unbounded read of a pathologically common entity would return the whole corpus in one response.

The same selection filters the ranked path accepts (`status`, `type`, `tag`, `topic_key`, and the global widening above) SHALL apply here with the same meaning. Filtering is not ranking: narrowing to what the caller asked for does not reintroduce relevance ordering, whereas silently ignoring a filter returns rows the caller explicitly excluded.

A text `query` supplied alongside an entity SHALL narrow, not rank: the entity's memories are filtered by case-insensitive substring containment over `title + content`, and the fetch SHALL cover more than the requested page so a match older than one page is not window-dropped. Substring containment, not the lexical branch, is deliberate — routing the narrowing through FTS5 would reintroduce exactly the tokenizer imprecision this index exists to remove.

This is deliberately the opposite of the text-query branch, and it exists because the identifier query class is the one where ranked retrieval performs worst.

#### Scenario: Every linked memory is returned

- **GIVEN** twenty memories in scope linked to one entity
- **WHEN** entity retrieval is performed for that entity
- **THEN** all twenty SHALL be returned, whether or not a `limit` was supplied

#### Scenario: A rare identifier is found regardless of embedding distance

- **GIVEN** a memory whose only connection to a query is a rare identifier, and which no text query surfaces in its top results
- **WHEN** entity retrieval is performed on that identifier
- **THEN** the memory SHALL be returned

#### Scenario: Entity retrieval applies no relevance boost

- **WHEN** entity retrieval returns results
- **THEN** the ordering SHALL be chronological and SHALL NOT be modified by confirmation count, recency, or type

#### Scenario: Narrowing by query is substring containment, not a second ranked pass

- **GIVEN** an entity linked to more memories than one page holds, one of them the oldest and the only one containing the query text
- **WHEN** entity retrieval is performed with that query
- **THEN** that memory SHALL be returned, matched case-insensitively, and the result SHALL NOT be ordered by any relevance score

### Requirement: The entity index MUST be rebuildable and its drift MUST be observable

All THREE entity tables are derived data, reconstructible from the append-only memory rows alone — the same class as the search and vector indexes. A rebuild path SHALL exist that recomputes them from `memory`, and it SHALL clear the scan bookkeeping table (`memory_entity_scan`) as well as the entity and link tables: the bookkeeping records THAT a memory was scanned, so a rebuild that empties only the knowledge tables leaves every row marked done and the drain finds nothing to do. Following a two-table procedure literally makes the rebuild a silent no-op, which is worse than no rebuild path at all because the operator believes the index was repaired.

The diagnostics surface SHALL report a link-count delta so drift caused by a missed backfill, a failed extraction, or a future table-rebuild migration is visible rather than silent.

#### Scenario: The index is rebuilt from primary data

- **GIVEN** a populated entity index
- **WHEN** all three tables are emptied and the rebuild runs
- **THEN** the index SHALL be reconstructed and entity retrieval SHALL return the same results as before it was emptied

#### Scenario: A rebuild that leaves scan bookkeeping is not a rebuild

- **GIVEN** a populated entity index
- **WHEN** the entity and link tables are emptied but `memory_entity_scan` is left populated
- **THEN** the drain SHALL find no work, and the documented rebuild procedure SHALL therefore clear all three

#### Scenario: Drift is reported

- **GIVEN** memories whose entities were never extracted
- **WHEN** diagnostics are read
- **THEN** a non-zero delta SHALL be reported as a warning
