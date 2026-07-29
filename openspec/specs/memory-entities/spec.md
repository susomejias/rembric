# memory-entities Specification

## Purpose

Deterministic, no-LLM extraction of syntactically-recognisable identifiers (file paths, git refs, URLs, error codes, tickets, CVEs, IPv4 addresses, self-hosted hostnames, systemd units, MAC addresses, env vars, UUIDs) from a memory's `title + content`, indexed and scoped like memories themselves. The index backs exact-address retrieval (an index lookup, not a ranked query), a save-time conflict-detection channel for entity overlap, and a precise seed for context relevance — while staying out of the existing hybrid-search RRF fusion, which it must not affect.

## Requirements

### Requirement: Entity extraction MUST be deterministic and MUST NOT use a model

Entities SHALL be extracted from a memory's `title + content` by a pure function with no inference, no model, and no network call, so extraction is reproducible, auditable, and free. Only entity kinds recognisable from syntax with high confidence SHALL be extracted: file paths, git refs, error codes, URLs, ticket-style identifiers, CVE ids, IPv4 addresses, self-hosted hostnames, systemd units, MAC addresses, environment variables, and UUIDs.

A kind SHALL be admitted only when its syntax is closed enough to reject prose without a denylist of English words. Kinds whose shape cannot be bounded that way — symbol identifiers, package names, semver strings, Docker image references, cron expressions — SHALL remain deliberately unsupported until a measured precision case exists for them.

An identifier class whose shape it shares with another class SHALL be separated by an anchor or a closed list, never by pattern order. Specifically: a token in `SCREAMING_SNAKE_CASE` SHALL NOT be typed on shape alone — it is indistinguishable between an error code, an environment variable and an ordinary constant — so `error_code` SHALL match only prefixed families (`ERR_`, `SQLITE_`, `E_`) plus closed name lists, and `env_var` SHALL require a `$`, `${}` or `=` anchor.

For `env_var` specifically, the ANCHOR requirement above DOMINATES the anti-prose requirement below, and the resulting false positive is accepted. A `$`-prefixed uppercase token used as a currency amount rather than a shell variable — `$MRR` in "grew $MRR by 12%" — satisfies the anchor and is therefore typed `env_var`. That is deliberate: the anchor is the closed-syntax gate this requirement demands, and the only narrowing that would reject it — requiring an underscore in the name — would also reject `$PATH`, `$HOME`, `$PWD`, `$SHELL` and `$EDITOR`, recoverable only through a closed name list and its ongoing maintenance. One bogus row does not buy that.

#### Scenario: An unanchored SCREAMING_SNAKE token is not typed

- **WHEN** a memory's content reads "export DATABASE_URL before starting"
- **THEN** no entity SHALL be linked for that token

#### Scenario: An anchored environment variable is typed

- **WHEN** a memory's content contains `NODE_ENV=production` or `$DATABASE_URL`
- **THEN** an entity of kind `env_var` SHALL be linked, carrying the bare name

#### Scenario: A currency sigil is still typed as an environment variable

- **WHEN** a memory's content reads "grew $MRR by 12% this quarter"
- **THEN** an entity of kind `env_var` with value `MRR` SHALL be linked, as the accepted cost of anchoring on the sigil

#### Scenario: A UUID does not yield a git ref

- **WHEN** a memory's content contains `550e8400-e29b-41d4-a716-446655440000`
- **THEN** an entity of kind `uuid` SHALL be linked and no `git_ref` SHALL be linked for its segments

Extraction and linking SHALL run **immediately after the save commits**, best-effort, and an extraction failure SHALL NOT fail the save — the memory is the primary record and the index is derived. They are deliberately NOT inside the save transaction: the save path computes the row's embedding between the commit and the linking, and holding a write transaction open across that would serialise every concurrent save behind one model call for the sake of an index that is rebuildable by construction. A memory whose linking never ran is indistinguishable from one the backfill has not reached yet, and the same resumable drain corrects both.

Prose that merely resembles an entity SHALL NOT be extracted: precision is preferred over recall, because a false entity link pollutes exact-address lookup, which is the mechanism's whole value.

A small number of extractions are known to violate that preference and are ACCEPTED as documented ambiguities, because every available narrowing costs more real identifiers than it removes bogus ones. Each SHALL be recorded in the list below, so it reads as a priced tradeoff rather than an undiscovered defect:

- `git_ref` accepts `accede1` and its shape-mates. Git's default short SHA is 7 characters, so raising the floor to 8 would drop real refs.
- `systemd_unit` accepts `user.service` as written in dependency-injection prose. The suffix is a real unit suffix and the surrounding grammar is not separable.
- `ticket` accepts `#4` and `#5` from titles such as "Opportunity-scan #4". The `#NN` form is published as legitimate above and already measured at 50% lexical noise, so this is a known cost; a minimum-digit floor would drop real single-digit issue references.
- `env_var` accepts a currency sigil, per the precedence clause above.

An extraction NOT on that list which is observed in a real corpus is a defect, and the requirement governing how it is corrected and pinned is stated separately.

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

| kind                                       | justification            | measured worst-case lexical noise                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`                                     | precision                | 67% — a path is a prefix (`.bak`) and a suffix (`test/…`) of other valid paths                                                                                                                                                 |
| `hostname`                                 | precision                | 67% — the dot is dropped, so `nas.local` matches "the nas local drive" and `backup-nas.local`                                                                                                                                  |
| `env_var`                                  | precision                | 67% — the underscore is dropped, so `DATABASE_URL` matches the prose "database url" and `DATABASE_URL_REPLICA`                                                                                                                 |
| `ticket`                                   | precision                | 50% — the `#` is dropped, so `#36` matches "36 files"; `PROJ-1234` is a phrase prefix of `PROJ-1234-B`                                                                                                                         |
| `ip_address`                               | precision                | 50% — an address is a phrase prefix of a longer dotted string                                                                                                                                                                  |
| `systemd_unit`                             | precision                | 50% — the dot is dropped, so `caddy.service` matches "the caddy service"; the suffix set is reduced (see below)                                                                                                                |
| `error_code` — `GRPC_STATUS_NAMES`         | precision                | 50% — the underscore is dropped, so `NOT_FOUND` and `PERMISSION_DENIED` are ordinary two-word prose                                                                                                                            |
| `error_code` — `ERR_`/`SQLITE_`/`E_`/errno | fixes a false extraction | 0% — prefixed and errno names have no prose form and no shorter valid sibling; the kind's value here is that unanchored `SCREAMING_SNAKE` was typed `error_code`, so `DATABASE_URL` and `MAX_RETRIES` polluted the error index |
| `uuid`                                     | fixes a false extraction | 0% — a UUID's first group satisfied the git-SHA shape, yielding a bogus `git_ref`                                                                                                                                              |
| `cve_id`                                   | fixes a false extraction | 0% — `CVE-2024-3094` yielded a bogus `ticket` of `CVE-2024`                                                                                                                                                                    |
| `mac_address`                              | enumeration              | 0% — the lexical branch cannot enumerate devices                                                                                                                                                                               |
| `git_ref`, `url`                           | enumeration              | 0% — these are self-terminating under tokenization                                                                                                                                                                             |

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

### Requirement: A bare dotted token MUST be a path only by closed dotfile-name membership

The `path` kind's bare-dotted-token form exists to catch dotfiles that carry no directory component: `.rembric` at a repository root is a real address. Admitting any dotted token of sufficient length instead extracts prose. Four such extractions were observed in a production index: `.length` is a property access, `.child` is an identifier fragment, `.sql` is a file TYPE rather than a file, and `.HERMES` is the generic placeholder session title this product's own session bookkeeping mints. None is an address, and none appeared alongside a path — a following `/` fails the form's lookahead, so the form fires only where no path exists.

A bare dotted token — one carrying no directory separator — SHALL be extracted as a `path` only when the FIRST dot-separated segment of the token, minus its leading dot, is a member of a closed list of known dotfile NAMES.

Membership SHALL be on that first segment rather than on the whole token, so a listed name may carry further segments: `.env.example` and `.mcp.json` are real files that appear in this repository's own README and specs, and an exact-token test would withhold exactly the identifiers this kind exists to address. Segmenting is what keeps the widening safe — a longer word that merely begins with a listed name has that whole word as its first segment, so `.envelope` is not admitted by `.env` being listed. A token bearing an EMPTY later segment — a doubled dot, as in `.env..example` — SHALL be rejected, because no filename has one.

#### Scenario: A listed dotfile name carrying further segments is extracted

- **WHEN** a memory's text contains `use .env.example as a template` or `see .mcp.json for the server config`
- **THEN** `.env.example` and `.mcp.json` SHALL each be extracted as a `path`

#### Scenario: A longer word beginning with a listed name is not extracted

- **WHEN** a memory's text contains `a .envelope of data arrived`
- **THEN** no `path` entity SHALL be produced

#### Scenario: A doubled dot is not a filename

- **WHEN** a memory's text contains `a .env..example typo`
- **THEN** no `path` entity SHALL be produced

Membership SHALL be by name and never by file EXTENSION. An extension test is not a narrowing: the file-type suffixes recognised for the directory-bearing form already include `sql`, so an extension-based allowlist would continue to admit `.sql`.

Membership SHALL be case-sensitive, because paths are case-sensitive and the `path` normalization deliberately does not fold case. A case-folding test would re-admit `.HERMES` the moment `.hermes` entered the list.

The list SHALL be declared in the rule registry alongside the patterns it gates, so it is inspectable and extendable without reading the extraction loop. It SHALL be seeded from the dotfiles this repository actually tracks (`git ls-files`), and the tracked set SHALL be asserted by a test, so a future trim of the list cannot silently drop an address the repo writes bare.

A dotted token bearing a directory separator SHALL be unaffected: this narrowing applies to the bare form only.

#### Scenario: A bare dotted token in prose yields no path

- **WHEN** a memory's content reads "the .length property is undefined", "run the .sql migrations by hand", "spawn returns a .child handle", or "the .HERMES marker is written"
- **THEN** no entity of kind `path` SHALL be linked for that token

#### Scenario: A listed dotfile name is still extracted

- **WHEN** a memory's content reads "the slug lives in .rembric at the root"
- **THEN** an entity of kind `path` with value `.rembric` SHALL be linked

#### Scenario: A dotfile-led relative path is unaffected

- **WHEN** a memory's content references `.claude/settings.local.json`
- **THEN** an entity of kind `path` with that value SHALL be linked

#### Scenario: A recognised file extension is not a dotfile name

- **WHEN** a bare dotted token's remainder is a file extension recognised for directory-bearing paths but is not a member of the dotfile-name list
- **THEN** no entity of kind `path` SHALL be linked

#### Scenario: Case does not admit an unlisted variant

- **WHEN** a bare dotted token differs from a listed dotfile name only in letter case
- **THEN** no entity of kind `path` SHALL be linked

#### Scenario: Every tracked dotfile still extracts

- **WHEN** each dotfile this repository tracks is written bare in a memory's content
- **THEN** each SHALL be extracted as a `path`, and the suite SHALL fail if a narrowing of the list drops one

### Requirement: Extraction MUST bound entities per memory, and the bound MUST NOT be reachable by one kind alone

A `find` listing or a lockfile dump pasted into a memory yields thousands of paths, none of them addresses worth indexing, so extraction SHALL cap the number of entities produced for a single memory. That cap is load-bearing behaviour and was previously unwritten — present in the code and absent from this contract, which is how its allocation defect shipped with no test at all.

The bound SHALL NOT be consumable by one kind alone. A budget exhausted by one rule SHALL NOT prevent a later rule from contributing, and a memory mentioning an identifier of a given kind SHALL be linked to at least one entity of that kind regardless of how many identifiers of other kinds it mentions. A silently dropped kind is indistinguishable from a memory that mentions none of that kind, which is the exact failure mode this index exists to remove.

Fairness SHALL be a floor per kind rather than an equal division of the bound: every kind present SHALL receive `min(its count, q)` for the largest per-kind quota `q` the bound admits, with any remainder distributed a slot at a time so the bound is filled EXACTLY rather than under-filled by a rounding artifact. A memory mentioning identifiers of one kind only SHALL still be able to consume the whole bound: dividing the budget equally across rules would truncate a genuine single-kind dump far below the bound for no benefit.

Allocation SHALL be grouped by KIND rather than by rule. Several rules can produce the same kind, so a per-rule share would make the subset kept depend on which rule happened to see a shared value.

Registry order SHALL remain presentation-only, as the registry's own comment asserts. The SET of entities extracted from a given text SHALL be invariant under permutation of the rule registry. Order MAY determine the sequence in which entities are reported; it SHALL NOT determine WHICH are reported. That invariance SHALL be asserted by a test: the comment claiming it was false in shipped code, and a contributor reordering the registry on its authority would have changed extraction semantics. The invariance test SHALL include a corpus in which at least three distinct kinds each exceed their fair share, so a remainder exists to distribute — a corpus without one passes with the kind sort, the value sort and the remainder pass all removed. Set equality alone cannot detect a uniform under-fill, so the exact fill SHALL be asserted separately.

Bounding SHALL NOT be achieved by collecting every match without limit and truncating afterwards. Extraction is required to stay linear in input length, and an unbounded intermediate collection over a 200KB input reintroduces the cost the bound exists to avoid.

#### Scenario: A dominant kind does not starve the others

- **GIVEN** a memory whose content holds several hundred distinct file paths followed by one ticket id, one errno, one anchored environment variable, one git ref and one self-hosted hostname
- **WHEN** entities are extracted
- **THEN** at least one entity of each of `ticket`, `error_code`, `env_var`, `git_ref` and `hostname` SHALL be present, and the total number of entities SHALL still respect the bound

#### Scenario: A single-kind memory still reaches the bound

- **GIVEN** a memory whose content holds more distinct file paths than the bound permits and no other identifier
- **WHEN** entities are extracted
- **THEN** the number of `path` entities SHALL be the bound, not an equal per-rule share of it

#### Scenario: A remainder is distributed rather than dropped

- **GIVEN** a memory whose content holds identifiers of three kinds, each well beyond the per-kind quota the bound admits
- **WHEN** entities are extracted
- **THEN** the total number of entities SHALL equal the bound exactly

#### Scenario: Permuting the rule registry does not change what is extracted

- **GIVEN** any text
- **WHEN** entities are extracted with the rule registry in its declared order and again with that order permuted
- **THEN** the two sets of `(kind, value)` pairs SHALL be identical

#### Scenario: The bound holds on an adversarial dump

- **WHEN** entities are extracted from a memory holding thousands of distinct identifiers across many kinds
- **THEN** the number of entities returned SHALL NOT exceed the bound

### Requirement: An observed false extraction MUST enter the zero-tolerance prose corpus as a test

Precision is the property this index is bought with, and a pattern that extracts prose is only ever discovered in a real corpus. A tightening SHALL therefore be recorded as an executable fixture rather than as prose: every false extraction observed in a real corpus SHALL be added to the zero-tolerance prose corpus as the SHORTEST text that reproduces it, asserted to yield zero entities of any kind. Recording the observation in a design document alone leaves nothing to stop the pattern regressing.

A tightening SHALL in the same change name the fixtures asserting the true positives its pattern still has to catch, so overshoot is detected in the same run as the fix. A narrowing that silences a false extraction by also dropping real addresses is not a fix.

The corpus that measures per-kind lexical noise SHALL NOT be treated as this gate. It measures the FTS5 lexical branch's behaviour for an identifier class, not the extractor's, and would not detect a pattern extracting prose.

#### Scenario: A tightening ships with its reproducer

- **WHEN** an extraction pattern is narrowed because it was observed extracting prose
- **THEN** the observed text SHALL be present in the zero-tolerance prose corpus, asserted to yield zero entities

#### Scenario: The prose corpus tolerates no entity of any kind

- **WHEN** any entry of the zero-tolerance prose corpus yields one or more entities
- **THEN** the test suite SHALL fail

#### Scenario: A tightening's true positives are asserted alongside it

- **WHEN** a pattern is narrowed
- **THEN** the examples the narrowed pattern must still catch SHALL be asserted in the same change, and the suite SHALL fail if the narrowing drops one

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

Exact-address retrieval is not a relevance problem: the caller has supplied an exact key. Retrieval by entity SHALL be an index lookup returning the linked memories in the requested scope, ordered chronologically, with no fusion, no rank window, no similarity threshold, and no post-fusion boost. It SHALL be complete within the scope up to an explicit, generous bound — a memory linked to the entity SHALL NOT be omitted because of a RANKING cutoff, and an omitted `limit` SHALL NOT be interpreted as the ranked branches' small default page. The bound SHALL be the same over-fetch ceiling those branches already use, so "complete" means "every linked memory, up to a stated cap far above any realistic per-entity link count" rather than "everything, unbounded" — an unbounded read of a pathologically common entity would return the whole corpus in one response. A `limit` the caller states explicitly SHALL still bound the page, exactly as on the ranked path (see `mcp-api`); completeness is what an OMITTED limit means, not an override of a stated one.

The same selection filters the ranked path accepts (`status`, `type`, `tag`, `topic_key`, and the global widening above) SHALL apply here with the same meaning. Filtering is not ranking: narrowing to what the caller asked for does not reintroduce relevance ordering, whereas silently ignoring a filter returns rows the caller explicitly excluded.

`status` composes only if the index covers every status, so **archived memories SHALL be indexed**. Excluding them made `status: 'archived'` a filter that could never match anything, and made every extractor recipe change drop the archived corpus's links permanently — a row archived before the bump is re-scanned by nothing, ever. Extraction is a pure synchronous function of `title + content`, so the only cost is a longer first drain on a corpus with many archived rows, paid once. The drain's queue and the operator-visible backlog count SHALL agree on that population, or the backlog never reaches zero.

Chronological ordering SHALL be a TOTAL order. `created_at` has millisecond resolution and a batch capture writes several memories inside one millisecond, so it alone is a partial order; the result is paged by the caller, and an unstable tie makes page 2 repeat or skip a row page 1 already showed. The ordering SHALL therefore carry a deterministic tiebreaker that is itself chronological.

A text `query` supplied alongside an entity SHALL narrow, not rank: the entity's memories are filtered by case-insensitive substring containment over `title + content`, and the fetch SHALL cover more than the requested page so a match older than one page is not window-dropped. Substring containment, not the lexical branch, is deliberate — routing the narrowing through FTS5 would reintroduce exactly the tokenizer imprecision this index exists to remove.

This is deliberately the opposite of the text-query branch, and it exists because the identifier query class is the one where ranked retrieval performs worst.

#### Scenario: Every linked memory is returned

- **GIVEN** twenty memories in scope linked to one entity
- **WHEN** entity retrieval is performed for that entity with no `limit`
- **THEN** all twenty SHALL be returned — the omitted `limit` means the generous bound, not the ranked default page

#### Scenario: An explicit limit still bounds the page

- **GIVEN** the same twenty linked memories
- **WHEN** entity retrieval is performed with `limit: 5`
- **THEN** five SHALL be returned; a stated limit is honoured rather than overridden by completeness

#### Scenario: An archived memory is reachable by entity

- **GIVEN** a memory linked to an entity and subsequently archived
- **WHEN** entity retrieval is performed for that entity with `status: 'archived'`
- **THEN** that memory SHALL be returned

#### Scenario: Same-millisecond rows page without repeating

- **GIVEN** four in-scope memories linked to one entity and all carrying the same `created_at`
- **WHEN** two consecutive pages of two are read
- **THEN** the four rows SHALL be partitioned across the pages, with none repeated and none dropped

#### Scenario: Narrowing by query is substring containment, not a second ranked pass

- **GIVEN** an entity linked to more memories than one page holds, one of them the oldest and the only one containing the query text
- **WHEN** entity retrieval is performed with that query
- **THEN** that memory SHALL be returned, matched case-insensitively, and the result SHALL NOT be ordered by any relevance score

#### Scenario: A rare identifier is found regardless of embedding distance

- **GIVEN** a memory whose only connection to a query is a rare identifier, and which no text query surfaces in its top results
- **WHEN** entity retrieval is performed on that identifier
- **THEN** the memory SHALL be returned

#### Scenario: Entity retrieval applies no relevance boost

- **WHEN** entity retrieval returns results
- **THEN** the ordering SHALL be chronological and SHALL NOT be modified by confirmation count, recency, or type

### Requirement: Entity overlap MUST be a save-time conflict-detection channel

Two memories can contradict each other while sharing almost no vocabulary and sitting far apart in embedding space — a fix and its reversal, stated in different words about the same file. Lexical and dense similarity both miss that case. A newly saved memory sharing a sufficiently rare entity with an existing active memory in the same scope SHALL therefore be eligible as a save-time candidate, alongside the existing lexical and dense channels.

Candidates surfaced this way SHALL carry a source identifying the entity channel, so the agent judging them knows why they were proposed. Common entities SHALL NOT generate candidates.

Rarity SHALL be measured over the population candidates are drawn from. BOTH sides of the proportion — the per-entity link count and the scope total it is divided by — SHALL count only memories whose `status` is `active`, excluding `superseded` and `archived` rows alike. Counting non-`active` rows is not a conservative approximation of that measurement, because a non-`active` row is never returned as a candidate: it makes the gate reject entities that cannot distort anything.

What the gate protects is COMPOSITION, not volume. Volume is bounded unconditionally by the per-save candidate maximum, gate or no gate. Composition is bounded by nothing else: entity-sourced candidates lead the merged list (see below), so a ubiquitous entity takes every slot and the lexical and dense channels contribute nothing. Only a memory that can OCCUPY a slot can starve another channel, and only an `active` memory can occupy one — which is what makes the `active` population derivable from the gate's purpose rather than merely asserted.

That population is load-bearing rather than pedantic, because the non-`active` population grows without bound. A `superseded` memory is never physically purged while a successor references it, and `topic_key` convergence concentrates a long-lived topic's entire superseded chain onto the SAME entity values — the same path, the same error code. Measuring rarity over non-`active` rows therefore drives the proportion up in proportion to a topic's age, and the channel SHALL NOT become inert on an evolving topic for that reason.

The three channels are merged into one list by a reported `similarity`, so that number SHALL be ONE quantity in every channel. Entity rarity SHALL NOT be that quantity. Rarity is the channel's ADMISSION gate — it decides whether the entity proposes anything at all — and reporting `1 - linkCount / scopeMemoryCount` as the similarity made a once-linked entity in a large scope report a near-1 score purely because the scope was large, outranking any realistic cosine and re-introducing the corpus-size dependence that was already removed from the lexical side. Every channel SHALL therefore report the same bounded `[0,1]` measure of how alike the two memories' text is: cosine where the dense branch found the pair, query-token containment otherwise.

Because that measure is near zero for exactly the pairs this channel exists to find, the channel's precedence SHALL be explicit rather than expressed through its score: entity-sourced candidates SHALL lead the merged list, and a target found by both the entity channel and another SHALL be reported as the entity one, because only that form carries the shared identifier. Ranking the channel on the shared measure alone would push its whole reason for existing past the per-save cap, behind candidates the other two channels would have surfaced anyway.

#### Scenario: A contradiction about the same file is surfaced

- **GIVEN** an active memory stating one approach for a specific file, and a new memory stating an incompatible approach for the same file, with little shared vocabulary
- **WHEN** the new memory is saved
- **THEN** the existing memory SHALL be surfaced as a candidate with the entity channel as its source

#### Scenario: A very common entity generates no candidates

- **GIVEN** an entity linked to a large share of the scope's active memories
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: The gate measures the active population, not the non-archived one

- **GIVEN** a scope holding roughly as many `superseded` memories as `active` ones, and an entity whose links are all on `active` memories and amount to a large share of them, while amounting to a share of the scope's non-archived memories that is below the rarity threshold
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: A long topic chain does not switch the channel off

- **GIVEN** an entity linked to one `active` memory and to many `superseded` memories forming a single `topic_key` chain, such that its share of the scope's non-archived memories exceeds the rarity threshold while its share of the scope's `active` memories is far below it
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity SHALL generate the `active` memory as a candidate, carrying the entity channel as its source

#### Scenario: Archived memories are counted on neither side

- **GIVEN** an entity linked to one `active` memory and to many `archived` memories in the same scope
- **WHEN** a new memory linked to that entity is saved
- **THEN** the rarity decision SHALL be identical to the decision taken with those archived memories absent from the scope

#### Scenario: The per-save candidate budget is respected

- **WHEN** the entity channel would surface more candidates than the per-save maximum permits
- **THEN** the total number of candidates SHALL still respect that maximum

#### Scenario: The reported similarity is text likeness, not entity rarity

- **GIVEN** a near-duplicate of the saved memory and an entity match sharing the identifier but almost no vocabulary
- **WHEN** candidates are detected
- **THEN** the entity candidate's reported `similarity` SHALL be the low text-likeness value and the near-duplicate's SHALL be higher
- **AND** the entity candidate SHALL still be first in the list, and SHALL survive a per-save maximum of one

### Requirement: The entity index MUST be rebuildable and its drift MUST be observable

All THREE entity tables are derived data, reconstructible from the append-only memory rows alone — the same class as the search and vector indexes. A rebuild path SHALL exist that recomputes them from `memory`, and it SHALL clear the scan bookkeeping table (`memory_entity_scan`) as well as the entity and link tables: the bookkeeping records THAT a memory was scanned, so a rebuild that empties only the knowledge tables leaves every row marked done and the drain finds nothing to do. Following a two-table procedure literally makes the rebuild a silent no-op, which is worse than no rebuild path at all because the operator believes the index was repaired.

The wipe SHALL be atomic, and the scan table SHALL be cleared FIRST. Three statements are three failure points, so a partial wipe would leave the index inconsistent with a marker asserting it was rebuilt. Ordering is the second half of the guarantee: clearing bookkeeping first means the worst reachable partial state is "bookkeeping gone, links intact", which the drain repairs idempotently, whereas the reverse leaves scan rows without links — a backlog reporting zero over a permanently empty index. After a wipe the drain SHALL consider work pending again without needing to be forced.

The recipe marker SHALL be two-phase: written as pending BEFORE the wipe, settled only after it commits, and a pending marker SHALL read as a mismatch. This is what makes an interrupted reset recoverable, and it replaces the previous reliance on the marker "already being on disk by the time the wipe runs". The marker's path SHALL be exported rather than private, and a boot that cannot complete the identity check SHALL name that path in its warning, so the operator can inspect it — the same obligation the embedding-identity marker carries.

An entity lookup issued while the drain is still running SHALL be distinguishable from a lookup of an unknown entity. Both return no rows, and after a recipe change the whole corpus is in that state for as long as the drain takes, so an agent told "empty means it is not there" concludes the identifier is unknown and falls back to a text query. An empty entity result over a scope that still has unscanned memories SHALL therefore carry a signal saying so.

The diagnostics surface SHALL report a link-count delta so drift caused by a missed backfill, a failed extraction, or a future table-rebuild migration is visible rather than silent. It SHALL additionally report that a reset is OWED whenever the marker does not name the running recipe and entity rows exist, because in that state the scan bookkeeping is intact and the backlog therefore reads zero — the index is neither draining nor correct, and nothing else distinguishes it from a healthy one. That report SHALL be a `memory.doctor` warning, SHALL be silent when no entity rows remain (there is nothing stale left to distrust), and SHALL NOT pay for a count of the link table on the healthy path.

#### Scenario: The index is rebuilt from primary data

- **GIVEN** a populated entity index
- **WHEN** all three tables are emptied and the rebuild runs
- **THEN** the index SHALL be reconstructed and entity retrieval SHALL return the same results as before it was emptied

#### Scenario: A rebuild that leaves scan bookkeeping is not a rebuild

- **GIVEN** a populated entity index
- **WHEN** the entity and link tables are emptied but `memory_entity_scan` is left populated
- **THEN** the drain SHALL find no work, and the documented rebuild procedure SHALL therefore clear all three

#### Scenario: An interrupted wipe cannot leave the index unrecoverable

- **WHEN** the wipe fails part-way through
- **THEN** no partial state SHALL be visible, and the marker SHALL NOT name the running recipe, so a later boot retries the reset

#### Scenario: A rolled-back wipe leaves the drain with nothing to do, and says so

- **GIVEN** a populated entity index and a recipe change whose wipe transaction rolls back entirely
- **THEN** the scan rows SHALL be restored, so the drain SHALL correctly report no pending work and the entity backlog SHALL read zero
- **AND** because that is indistinguishable from a healthy index, the diagnostics surface SHALL report the owed reset until a later boot completes it

#### Scenario: A lookup during a drain is not reported as an unknown entity

- **GIVEN** a memory referencing an identifier, saved but not yet scanned
- **WHEN** entity retrieval is performed for that identifier
- **THEN** the result SHALL be empty AND SHALL carry the draining signal
- **AND** once the scope is fully scanned, a genuine miss SHALL NOT carry it

#### Scenario: Drift is reported

- **GIVEN** memories whose entities were never extracted
- **WHEN** diagnostics are read
- **THEN** a non-zero delta SHALL be reported as a warning

### Requirement: A change to the extraction recipe MUST retroactively correct already-indexed memories

Because the scan bookkeeping records THAT a memory was scanned and not WHICH recipe scanned it, a corrected pattern would otherwise apply only to newly-saved memories, leaving every existing one misclassified forever. A misclassification is therefore not permanent by construction: the extractor SHALL carry a version tag covering its patterns, its normalization and its kind set, and a mismatch against the tag recorded on disk SHALL invalidate the derived index at boot so the ordinary backfill drain recomputes it from the append-only `memory` rows. A marker left PENDING counts as such a mismatch, per the two-phase rule above, so an interrupted reset is retried on the next boot even though the version it records is the running one.

The reset SHALL NOT be triggered by an ordinary deployment — only by a recipe change or by a prior reset that did not settle — and SHALL NOT modify any `memory` row. A rebuild SHALL also remain available on demand from the operator dashboard, so a fix need not wait for a release.

The drain SHALL be paced so this window is bounded: entity retrieval is specified as complete within scope, and a corpus-wide rebuild leaves it incomplete until the drain finishes.

#### Scenario: A misclassified memory is corrected by a recipe change

- **GIVEN** a memory indexed under a recipe that classified it incorrectly
- **WHEN** the pattern is fixed and the extractor version is bumped
- **THEN** the incorrect entity link SHALL be gone after the drain, the correct one present, and the memory's `content` unchanged

#### Scenario: An ordinary deployment does not rebuild the index

- **GIVEN** an install whose recorded extractor version matches the compiled-in one AND whose marker is settled rather than pending
- **WHEN** the server boots
- **THEN** the entity index SHALL NOT be truncated and no re-scan SHALL be scheduled

#### Scenario: A corpus scanned to zero entities is still re-scanned

- **GIVEN** an install whose memories were all scanned under an older recipe but produced no entities
- **WHEN** the extractor version no longer matches
- **THEN** the scan bookkeeping SHALL be cleared so the drain re-scans them

### Requirement: Entity retrieval MUST NOT be added as a fusion stream in this change

Published evidence indicates that adding a graph stream to a BM25-plus-vector fusion **reduced** Recall@5, NDCG@10 and MRR against BM25 alone in its own author's benchmark. Entity retrieval SHALL therefore remain a separate exact-address mechanism and SHALL NOT contribute a ranked list to the text-query branch's Reciprocal Rank Fusion. Introducing such a stream SHALL require a measured improvement on the evaluation harness, recorded in a dedicated change.

#### Scenario: The text-query branch is unchanged

- **WHEN** `memory.search` is called with a text query and no entity filter
- **THEN** the fused result SHALL be identical to what the same query returns without the entity index present
