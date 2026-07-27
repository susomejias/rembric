## ADDED Requirements

### Requirement: A bare dotted token MUST be a path only by closed dotfile-name membership

The `path` kind's bare-dotted-token form exists to catch dotfiles that carry no directory component: `.rembric` at a repository root is a real address. Admitting any dotted token of sufficient length instead extracts prose. Four such extractions were observed in a production index: `.length` is a property access, `.child` is an identifier fragment, `.sql` is a file TYPE rather than a file, and `.HERMES` is the generic placeholder session title this product's own session bookkeeping mints. None is an address, and none appeared alongside a path — a following `/` fails the form's lookahead, so the form fires only where no path exists.

A bare dotted token — one carrying no directory separator — SHALL be extracted as a `path` only when the FIRST dot-separated segment of the token, minus its leading dot, is a member of a closed list of known dotfile NAMES.

Membership SHALL be on that first segment rather than on the whole token, so a listed name may carry further segments: `.env.example` and `.mcp.json` are real files that appear in this repository's own README and specs, and an exact-token test would withhold exactly the identifiers this kind exists to address. Segmenting is what keeps the widening safe — a longer word that merely begins with a listed name has that whole word as its first segment, so `.envelope` is not admitted by `.env` being listed.

#### Scenario: A listed dotfile name carrying further segments is extracted

- **WHEN** a memory's text contains `use .env.example as a template` or `see .mcp.json for the server config`
- **THEN** `.env.example` and `.mcp.json` SHALL each be extracted as a `path`

#### Scenario: A longer word beginning with a listed name is not extracted

- **WHEN** a memory's text contains `a .envelope of data arrived`
- **THEN** no `path` entity SHALL be produced

Membership SHALL be by name and never by file EXTENSION. An extension test is not a narrowing: the file-type suffixes recognised for the directory-bearing form already include `sql`, so an extension-based allowlist would continue to admit `.sql`.

Membership SHALL be case-sensitive, because paths are case-sensitive and the `path` normalization deliberately does not fold case. A case-folding test would re-admit `.HERMES` the moment `.hermes` entered the list.

The list SHALL be declared in the rule registry alongside the patterns it gates, so it is inspectable and extendable without reading the extraction loop.

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

### Requirement: Extraction MUST bound entities per memory, and the bound MUST NOT be reachable by one kind alone

A `find` listing or a lockfile dump pasted into a memory yields thousands of paths, none of them addresses worth indexing, so extraction SHALL cap the number of entities produced for a single memory. That cap is load-bearing behaviour and was previously unwritten — present in the code and absent from this contract, which is how its allocation defect shipped with no test at all.

The bound SHALL NOT be consumable by one kind alone. A budget exhausted by one rule SHALL NOT prevent a later rule from contributing, and a memory mentioning an identifier of a given kind SHALL be linked to at least one entity of that kind regardless of how many identifiers of other kinds it mentions. A silently dropped kind is indistinguishable from a memory that mentions none of that kind, which is the exact failure mode this index exists to remove.

Fairness SHALL be a floor per kind rather than an equal division of the bound. A memory mentioning identifiers of one kind only SHALL still be able to consume the whole bound: dividing the budget equally across rules would truncate a genuine single-kind dump far below the bound for no benefit.

Registry order SHALL remain presentation-only, as the registry's own comment asserts. The SET of entities extracted from a given text SHALL be invariant under permutation of the rule registry. Order MAY determine the sequence in which entities are reported; it SHALL NOT determine WHICH are reported. That invariance SHALL be asserted by a test: the comment claiming it was false in shipped code, and a contributor reordering the registry on its authority would have changed extraction semantics.

Bounding SHALL NOT be achieved by collecting every match without limit and truncating afterwards. Extraction is required to stay linear in input length, and an unbounded intermediate collection over a 200KB input reintroduces the cost the bound exists to avoid.

#### Scenario: A dominant kind does not starve the others

- **GIVEN** a memory whose content holds several hundred distinct file paths followed by one ticket id, one errno, one anchored environment variable, one git ref and one self-hosted hostname
- **WHEN** entities are extracted
- **THEN** at least one entity of each of `ticket`, `error_code`, `env_var`, `git_ref` and `hostname` SHALL be present, and the total number of entities SHALL still respect the bound

#### Scenario: A single-kind memory still reaches the bound

- **GIVEN** a memory whose content holds more distinct file paths than the bound permits and no other identifier
- **WHEN** entities are extracted
- **THEN** the number of `path` entities SHALL be the bound, not an equal per-rule share of it

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

## MODIFIED Requirements

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

A small number of extractions are known to violate that preference and are ACCEPTED as documented ambiguities, because every available narrowing costs more real identifiers than it removes bogus ones. Each SHALL be recorded beside the rule it belongs to, so it reads as a priced tradeoff rather than an undiscovered defect:

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

### Requirement: The entity index MUST be rebuildable and its drift MUST be observable

All THREE entity tables are derived data, reconstructible from the append-only memory rows alone — the same class as the search and vector indexes. A rebuild path SHALL exist that recomputes them from `memory`, and it SHALL clear the scan bookkeeping table (`memory_entity_scan`) as well as the entity and link tables: the bookkeeping records THAT a memory was scanned, so a rebuild that empties only the knowledge tables leaves every row marked done and the drain finds nothing to do. Following a two-table procedure literally makes the rebuild a silent no-op, which is worse than no rebuild path at all because the operator believes the index was repaired.

The wipe SHALL be atomic, and the scan table SHALL be cleared FIRST. Three statements are three failure points, so a partial wipe would leave the index inconsistent with a marker asserting it was rebuilt. Ordering is the second half of the guarantee: clearing bookkeeping first means the worst reachable partial state is "bookkeeping gone, links intact", which the drain repairs idempotently, whereas the reverse leaves scan rows without links — a backlog reporting zero over a permanently empty index. After a wipe the drain SHALL consider work pending again without needing to be forced.

The recipe marker SHALL be two-phase: written as pending BEFORE the wipe, settled only after it commits, and a pending marker SHALL read as a mismatch. This is what makes an interrupted reset recoverable, and it replaces the previous reliance on the marker "already being on disk by the time the wipe runs".

An entity lookup issued while the drain is still running SHALL be distinguishable from a lookup of an unknown entity. Both return no rows, and after a recipe change the whole corpus is in that state for as long as the drain takes, so an agent told "empty means it is not there" concludes the identifier is unknown and falls back to a text query. An empty entity result over a scope that still has unscanned memories SHALL therefore carry a signal saying so.

The diagnostics surface SHALL report a link-count delta so drift caused by a missed backfill, a failed extraction, or a future table-rebuild migration is visible rather than silent. It SHALL additionally report that a reset is OWED whenever the marker does not name the running recipe and entity rows exist, because in that state the scan bookkeeping is intact and the backlog therefore reads zero — the index is neither draining nor correct, and nothing else distinguishes it from a healthy one.

#### Scenario: An interrupted wipe cannot leave the index unrecoverable

- **WHEN** the wipe fails part-way through
- **THEN** no partial state SHALL be visible, and the marker SHALL NOT name the running recipe, so a later boot retries the reset

#### Scenario: A rolled-back wipe leaves the drain with nothing to do, and says so

- **GIVEN** a populated entity index and a recipe change whose wipe transaction rolls back entirely
- **THEN** the scan rows SHALL be restored, so the drain SHALL correctly report no pending work and the entity backlog SHALL read zero
- **AND** because that is indistinguishable from a healthy index, the diagnostics surface SHALL report the owed reset until a later boot completes it

#### Scenario: A lookup during a drain is not reported as an unknown entity

- **GIVEN** a memory referencing an identifier, saved but not yet scanned
- **WHEN** an entity lookup for that identifier runs in the same scope
- **THEN** the response SHALL carry a draining signal rather than presenting the empty result as a definitive absence
