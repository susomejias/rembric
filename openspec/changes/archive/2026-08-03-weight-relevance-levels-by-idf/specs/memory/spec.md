## MODIFIED Requirements

### Requirement: Recall MUST be able to return nothing

The text-query branch SHALL be able to report that it found nothing relevant, rather than always returning the highest-scoring available rows. A confidently-irrelevant result is worse than an empty one, because the calling agent has no signal to distrust it and will treat it as established project knowledge.

Both gates SHALL read ONE quantity, at ONE point in the pipeline.

The quantity is a per-row **relevance level** in `[0,1]`: the greater of (a) the **inverse-document-frequency-weighted** fraction of the query's distinct terms present in the row's title and content, and (b) the dense branch's cosine similarity for that row.

The lexical component SHALL be the sum of the weights of the query terms the row contains divided by the sum of the weights of all the query's distinct terms, and each term's weight SHALL be strictly positive at every document frequency so that the denominator is never zero and the component is bounded to `[0,1]` by construction. Its two halves are sourced differently and that asymmetry is contracted, not incidental: the query's terms and their weights come from the index's own tokenizer and statistics, while whether a row contains a term is decided by the application's tokenisation, whose disagreement with the index can only lower a row's lexical component and can never fabricate a weight (see "Term-statistics lookups MUST be keyed on the index's own terms"). An UNWEIGHTED fraction SHALL NOT be used: it measures the share of the query's tokens a row carries rather than the share of its information, so a question-shaped query with no answer in the corpus scores on its function words alone. The committed grid in `openspec/changes/archive/2026-07-28-rescore-relevance-abstention/measurements/sweep.txt` records the consequence — an empty-gold query at 0.455 above a gold-bearing query at 0.333, with no threshold between them.

The level is therefore corpus-DEPENDENT, and SHALL NOT be described as independent of corpus size. What SHALL hold instead is that the level depends only on the query, the row, and corpus-wide term statistics — never on the result list the level is used to filter, on the page requested, or on the order the branches fused in. Corpus growth consequently moves levels, and SHALL move them in one direction only: a term appearing in more documents SHALL never gain weight, so rows carrying the query's rarer terms SHALL never lose ground to rows carrying only its commoner ones. The level SHALL NOT be derived from:

- **raw or logistically-normalised `bm25()`** — unbounded, corpus-relative, and, because FTS5 clamps a non-positive IDF to `1e-6`, always at or above 0.5 under the logistic, saturating to 0.98 within a few IDF units. No absolute threshold on it can fire in the usable range;
- **fused RRF scores** — a function of rank position, not of match quality. Their consecutive ratios are fixed by the rank constant (0.984 rising to 0.996 within a branch-membership class, exactly 0.500 across the both-branches → single-branch boundary), so a threshold over them selects branch membership rather than relevance;
- **any window-relative normalisation** (min-max, rank-percentile, z-score over the branch's own rank window) — each maps the window's best row to a constant, so it can express the _shape_ of a result list but never its _level_, and an absolute floor is a statement about level;
- **term statistics computed over the candidate pool** — the pool is not a sample of the corpus but the set of rows the query already matched, so a discriminative term is over-represented in it precisely because it drove the match, and its pool-derived weight is anti-correlated with its true rarity. This is the same error as the window-relative normalisations above, applied to the weights instead of to the score.

The evaluation point is **after fusion and before the ranking boost**. After fusion, because the page only exists once the branches are fused. Before the boost, because the boost is a ranking multiplier over recency, type and confirmation count with a reachable spread of 1.5× — it is not a relevance measure, and a gate placed behind it lets a fresh, repeatedly-confirmed, irrelevant row clear an abstention check that a stale relevant row fails.

At that point the two gates are:

- The **floor** is absolute and is compared against the highest relevance level in the **whole fused pool**, not a `limit + offset` prefix of it. When no row in the pool reaches the floor, the response SHALL contain no results and SHALL carry an explicit abstention flag and a reason. Levelling a prefix would make both gates a function of the page requested and of the order the branches happened to fuse in: a deeper page widens the prefix and can only raise the leader, so the same query against the same corpus could abstain at one offset and not at the next, and a row the filter judged relevant could be cut from the pool the page is then sliced out of.
- The **relative filter** keeps a row only while its level is at or above `ratio × leaderLevel`, where `leaderLevel` is the same pool maximum the floor used, and preserves fused order. It is a per-row test **relative to the best level**, not a truncation at the first consecutive-pair drop: a gradually decaying tail passes every consecutive test and so returns rows far below the leader, and over a level sequence that is not monotone in fused order, truncating at the first offender discards strictly better rows behind it.

A page shortened by the relative filter SHALL NOT be padded to the requested limit, and SHALL report `abstained: false` — abstention is the floor's verdict, and a caller MUST be able to tell "nothing relevant exists" from "fewer than `limit` rows were relevant".

Each gate is independently enabled or disabled, and the shipped state of each is recorded once, in "Retrieval and lifecycle constants MUST be named and bounded in one place", so that this requirement does not have to be edited whenever a constant moves. While BOTH gates are disabled the branch SHALL perform no gate-related work at all: it SHALL issue the same queries and return the same result ids as if the gates did not exist. While EITHER gate is enabled the branch SHALL compute levels for the whole fused pool, and the cost of doing so SHALL be measured against a stated budget at 1 000, 20 000 and 50 000 memory rows before the enabling change lands.

#### Scenario: A question-shaped query is not carried by its function words

- **GIVEN** a scope whose memories all contain the terms `how`, `does`, `the` and `for`, none of which answers the query, and a query composed of those terms plus one term absent from the scope
- **WHEN** the relevance level of the best-matching row is computed
- **THEN** it SHALL be lower than the level of a row in the same scope that contains the query's absent term, and the difference SHALL come from the weighting rather than from the number of terms matched

#### Scenario: A query with nothing relevant abstains

- **GIVEN** the floor is enabled with a calibrated value, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: A gate decision does not change when the corpus grows

- **GIVEN** the floor and the relative filter are enabled, and a query whose decision is recorded against a corpus
- **WHEN** the corpus is enlarged with rows that share the query's vocabulary without answering it, so they sort ahead of the answering row
- **THEN** both gates SHALL reach the same decision and the answering row SHALL still be returned — every fused candidate is levelled, and the added rows can only lower the weight of the terms they share, which lowers their own levels rather than the answering row's

#### Scenario: A gate decision does not change with the page requested

- **GIVEN** the floor is enabled and a query whose pool contains more candidates than one page
- **WHEN** the same query is issued at several offsets
- **THEN** every page SHALL report the same abstention verdict

#### Scenario: A gradually decaying tail is cut

- **GIVEN** the relative filter is enabled at a ratio of 0.5, and a fused pool whose relevance levels are 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the rows at 0.4 and 0.3 SHALL be omitted, because each is below `0.5 × 0.9`

#### Scenario: A sharp query returns a short result set

- **GIVEN** the relative filter is enabled, and a scope containing one strongly-matching memory and several weak ones
- **WHEN** `memory.search` is called with a limit larger than one
- **THEN** the weak results below `ratio × leaderLevel` SHALL be omitted, and the response SHALL NOT be padded to the requested limit

#### Scenario: A short page is distinguishable from an abstention

- **GIVEN** the relative filter is enabled and it drops every row but two, while the leader clears the floor
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the response SHALL contain two results and SHALL report `abstained: false`

#### Scenario: Abstention is off by default

- **GIVEN** both the floor and the relative filter are disabled
- **WHEN** `memory.search` is called
- **THEN** the text-query branch SHALL return the same result ids it returns with the gates removed, returning up to the requested limit, and SHALL issue no additional database read on their behalf — neither the pool's text nor any term statistic



### Requirement: Save-time lexical candidate scoring MUST increase with match quality

FTS5's bm25 score is negative and unbounded, and a better match is _more_ negative. Any similarity derived from it SHALL be monotonically **increasing** in match quality, and SHALL be bounded to `[0, 1]` so that the value reported to the agent as `similarity` is truthful against its documented range and comparable with the cosine similarity produced by the dense detector.

Because bm25 magnitudes scale with corpus size and term IDF, the system SHALL NOT gate lexical candidates on an absolute threshold over the raw bm25 value: no such threshold is stable across corpus sizes. Admission SHALL instead be by rank position within the already-correctly-ordered candidate pool, and the reported `similarity` SHALL be computed as a corpus-independent lexical overlap measure between the saved text and the candidate.

That overlap measure SHALL remain UNWEIGHTED, and SHALL NOT be replaced by the inverse-document-frequency weighting the search path's relevance level uses (see "Recall MUST be able to return nothing"). The two serve different contracts: `similarity` is reported to the agent as a number in a documented range and is required above to be corpus-independent, while the level exists to be thresholded and is required to be corpus-dependent. The two paths SHALL nonetheless share ONE tokenisation, so they cannot disagree about what a token is.

#### Scenario: A byte-identical duplicate is surfaced lexically

- **GIVEN** a scope containing at least fifty active memories, and a newly saved memory whose text is byte-identical to one of them, with no embedding available
- **WHEN** save-time candidate detection runs
- **THEN** the identical memory SHALL be surfaced as a candidate with `source: 'fts'`
- **AND** its reported `similarity` SHALL be 1.0

#### Scenario: A near-zero-IDF match is not reported as identical

- **GIVEN** a scope in which a term appears in nearly every memory
- **WHEN** a save shares only that term with an otherwise unrelated memory
- **THEN** that memory SHALL NOT be reported with a `similarity` near 1.0
- **AND** it SHALL NOT displace a genuinely similar candidate from the per-save candidate budget

#### Scenario: Lexical detection does not go silent as the corpus grows

- **GIVEN** the same duplicate-save scenario evaluated at corpus sizes of 50, 150 and 300 active memories
- **WHEN** save-time candidate detection runs at each size
- **THEN** the identical memory SHALL be surfaced at every size

#### Scenario: Save-time similarity does not move with the corpus

- **GIVEN** one saved text and one candidate memory, evaluated in two scopes whose other memories differ entirely
- **WHEN** save-time candidate detection runs in each
- **THEN** the reported `similarity` SHALL be identical in both, unaffected by how common the shared terms are in either corpus



### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it IS the admission rule (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the share of a scope's active memories above which an entity stops proposing save-time candidates. It is a proportion rather than an absolute count so the BLOCKING decision does not become inert as a corpus grows, and it SHALL be consulted only once the entity's active link count reaches `ENTITY_RARITY_MIN_LINKS` below. It SHALL NOT be described as bounding candidate COMPOSITION at every corpus size: a fixed proportion admits a link count that rises with the active population while the per-save budget does not, so above an active count of the budget divided by this threshold a single admitted entity may still fill every slot (see `memory-entities`).
- `ENTITY_RARITY_MIN_LINKS` — the active link count below which the rarity gate above does not apply at all, so an entity linked to fewer active memories than the per-save budget holds is admitted whatever its proportion. Derived ONCE from `CANDIDATES_PER_SAVE_MAX`'s default and NOT read from that setting at request time: such an entity cannot occupy the budget by itself — though several separately-exempt entities from one save can, which `memory-entities` records — while following the operator's value would make an admission rule environment-settable and, at a value of zero, would invert the gate into one that always applies.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection. The reads behind it carry no `LIMIT`, so the complete per-memory count is in hand where the bound is applied and SHALL be reported as a count rather than as an indication that the bound was hit. Unlike `CANDIDATE_POOL_SIZE` above there is no pool upstream of it, so that count is exact and MAY carry a `Total` suffix. It SHALL be applied to a fair-shared order rather than an arbitrary one (see `mcp-api`), so that what the bound withholds is a stated consequence of the memory's entity composition rather than an accident of kind naming — a bound over an arbitrary order cannot be reviewed, because what it costs is unknowable. Changing its value SHALL therefore be argued against a measured distribution of entities per memory, produced by running the shipped extractor over production-shaped content, not against the returned array's length.
- `PREDECESSOR_CAP` — the bound on `memory.get`'s predecessor PROJECTION, and nothing else. Its value is a token budget for that one response, so no other consumer of the `replaces` ancestry SHALL borrow it: a decision to show more or fewer predecessors would otherwise silently change unrelated behaviour elsewhere.
- `DISMISSAL_ANCESTRY_CAP` — how far back along the `replaces` ancestry a `not_conflict` dismissal is carried forward when save-time candidates are suppressed. A suppression-reach decision, not a payload decision, and SHALL be declared separately from `PREDECESSOR_CAP` even while the two hold the same value.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.
- `ANNOTATION_REASON_CHARS` — the character bound applied to a judged annotation's `reason` on the multi-row annotation surfaces. It bounds a READ PROJECTION only: the stored `reason` and its input cap are untouched, and the single-memory deep read projects the value verbatim (see the `mcp-api` capability, "Relation annotation reasons MUST be bounded on multi-row reads").
- `RELATION_ANNOTATION_RESPONSE_BUDGET` — the maximum number of annotations one multi-row response may project, bounding `row count × per-row annotation bound`. It SHALL be derived from shipped default behaviour so that no request relying on defaults can be rejected by it — and that derivation SHALL use the LARGEST row count any branch serves for an omitted `limit`, not the `limit` maximum. The entity branch's page size when no `limit` is given exceeds the `limit` maximum, so deriving from the latter leaves that branch able to project several times the budget. It is not itself a per-request tunable: it bounds the product of two request parameters, and a request exceeding it is rejected rather than served with a reduced projection.
- The annotation payload ceiling — the maximum serialized size the annotation projection of any legal request may reach, asserted in CI against a measured worst-case response rather than against the product of the constants above (see the `mcp-api` capability, "The worst-case annotation payload MUST be bounded by a named ceiling asserted in CI").

Three of those constants are gates whose shipped state is recorded HERE and nowhere else, so that exactly one requirement has to be edited when one of them moves: the abstention floor and `RELATIVE_LEVEL_RATIO` (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. The abstention floor and `DIVERSITY_CAP` ship disabled (`null`); `RELATIVE_LEVEL_RATIO` ships ENABLED, at a value carried by a committed sweep. A gate's disabled state is not itself the contract — an uncalibrated gate silently removes recall, so what is contracted is the evidence a commit must carry to enable one, and any statement elsewhere in this capability about which gates are currently on SHALL defer to this paragraph.

Enabling the abstention floor or `RELATIVE_LEVEL_RATIO` SHALL require, in the same change:

1. a committed sweep across a grid of candidate values, produced by the evaluation harness rather than asserted;
2. an over-abstention rate of zero at every committed `k` — no query with a gold answer returns nothing;
3. an abstention false-positive rate at or below its committed cap;
4. precision, recall and MRR at or above their committed floors at every committed `k`;
5. the chosen value in the interior of an admissible plateau at least **0.10 wide in level units** on each of the criteria above — an absolute width, not a count of grid steps, because the grid's resolution is chosen by the same change that is being judged and refining it manufactures compliance without changing anything real. The sweep's grid step SHALL be no coarser than 0.05, so a compliant plateau is always resolved by at least two measured points either side of the chosen value, and a value that holds only across a narrower band SHALL be rejected as a cliff edge rather than accepted as a calibration.

A change to the relevance level's definition SHALL re-derive every enabled gate's value from a fresh sweep and SHALL NOT carry a value forward: a constant calibrated against a different quantity is uncalibrated.

Enabling `DIVERSITY_CAP` SHALL additionally require a session-labelled evaluation fixture, because it is applied to the whole fused pool before the page is sliced — a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, which on a single-topic session measurably swaps most of page 1 for noise — and the current corpus cannot see that regression, every corpus row carrying a null session id, which is never grouped.

That sweep obligation SHALL NOT be extended to `ENTITY_RARITY_THRESHOLD` by analogy. The evaluation harness enters retrieval through the ranked search path and never runs save-time candidate detection, so the harness cannot observe this gate's decisions at all and a sweep over it would report an unmoved baseline at every grid point — a measurement that discriminates nothing while appearing to calibrate. A change to this constant SHALL instead carry a decision table over the gate's own inputs (the active link count and the active scope total), stating both the admitting and the blocking direction with each proportion's denominator, because the decision function is exhaustively enumerable over those two integers where a corpus is only a sample of them.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: The candidate pool size is not operator-configurable

- **WHEN** the environment schema is inspected
- **THEN** neither `CANDIDATE_POOL_SIZE` nor `ENTITY_RARITY_MIN_LINKS` SHALL be readable from the environment, and `CANDIDATES_PER_SAVE_MAX` SHALL remain the only operator knob over save-time candidate surfacing

#### Scenario: The entity link minimum does not follow the operator's per-save maximum

- **GIVEN** an operator setting `CANDIDATES_PER_SAVE_MAX` to a value other than its default
- **WHEN** the entity channel's rarity gate is evaluated
- **THEN** the link count below which the gate does not apply SHALL be the compile-time constant, unchanged by that setting

#### Scenario: A disabled gate stays disabled without a calibration

- **WHEN** the abstention floor, `RELATIVE_LEVEL_RATIO`, or the diversity cap is enabled
- **THEN** the change SHALL be accompanied by a measurement on the evaluation harness, and for the diversity cap by a session-labelled fixture the harness can see the regression through

#### Scenario: A gate is enabled without a committed sweep

- **WHEN** a change sets the abstention floor or `RELATIVE_LEVEL_RATIO` to a non-null value without a committed harness sweep across a grid of candidate values
- **THEN** the change SHALL be rejected

#### Scenario: A candidate value that costs recall is rejected

- **GIVEN** a swept candidate value at which any query with a gold answer returns nothing
- **WHEN** that value is proposed for the abstention floor
- **THEN** it SHALL be rejected regardless of its abstention false-positive rate

#### Scenario: A candidate value that holds at only one grid point is rejected

- **GIVEN** a swept candidate value that meets every criterion at its own grid point and fails at both adjacent grid points
- **WHEN** that value is proposed
- **THEN** it SHALL be rejected as a cliff edge, and the gate SHALL remain disabled

#### Scenario: Refining the grid does not manufacture a plateau

- **GIVEN** an admissible band 0.03 wide in level units, and a sweep whose grid step is refined to 0.005 so that six consecutive grid points inside that band pass every criterion
- **WHEN** a value from the interior of that band is proposed
- **THEN** it SHALL be rejected, because the plateau is narrower than 0.10 in level units regardless of how many grid points fall inside it

#### Scenario: A new level function does not inherit the old calibration

- **GIVEN** an enabled gate whose value was chosen on a sweep over the previous relevance-level definition
- **WHEN** a change alters how the relevance level is computed
- **THEN** that change SHALL re-run the sweep and re-derive the value, and SHALL be rejected if it carries the value forward on the strength of the superseded grid

#### Scenario: A harness sweep is not accepted as a calibration of the rarity gate

- **GIVEN** a change to `ENTITY_RARITY_THRESHOLD` whose only evidence is an evaluation-harness sweep
- **WHEN** that change is reviewed
- **THEN** it SHALL be rejected, because the harness does not run save-time candidate detection and its unmoved baseline is not evidence about this gate

#### Scenario: Re-enabling the diversity cap without a session-labelled fixture

- **WHEN** `DIVERSITY_CAP` is set to a non-null value while every row in the evaluation corpus carries a null session id
- **THEN** the change SHALL be rejected, because the harness cannot observe the regression the cap causes

#### Scenario: The projection bound is not reused as the suppression bound

- **WHEN** `PREDECESSOR_CAP` is changed
- **THEN** the depth of save-time dismissal suppression SHALL be unchanged, and no module outside `memory.get`'s predecessor projection SHALL read that constant

#### Scenario: The projection bound is changed without a distribution

- **WHEN** a change alters `ENTITIES_PROJECTION_CAP` citing only that the bound is reached, without a measured distribution of entities per memory over production-shaped content
- **THEN** the change SHALL be rejected

#### Scenario: The annotation payload constants are declared once

- **WHEN** the modules owning the annotation projection are inspected
- **THEN** `ANNOTATION_REASON_CHARS` and `RELATION_ANNOTATION_RESPONSE_BUDGET` SHALL each be declared exactly once, alongside `RELATION_ANNOTATION_MAX`, and every enforcement site SHALL read them from that declaration rather than restating a literal

## ADDED Requirements

### Requirement: The relevance level's term statistics MUST come from the search index

The weights in the relevance level's lexical component are document frequencies, and where they are read from decides whether a threshold over the level means anything. They SHALL be read from the full-text index's own term statistics — the document count of each term across every indexed row — and the document total SHALL be the same population that index covers, so that a weight and its total are never drawn from two different denominators.

The statistics SHALL NOT be derived from the candidate pool, from the requested page, or from any set that the query itself selected.

They SHALL be defined at every corpus size, with no minimum-corpus fallback and no clamping regime:

- a term present in every indexed document SHALL still carry a strictly positive weight, so a query composed only of ubiquitous terms still has a defined level;
- a term absent from the index entirely SHALL carry the maximum weight, so failing to match the query's rarest term is the strongest available evidence of irrelevance;
- when every term of a query carries the same weight, the weighted fraction SHALL equal the unweighted fraction, so a corpus too small to discriminate degrades to the previous behaviour rather than to a discontinuity.

These statistics are aggregates over the whole index and are therefore NOT scope-filtered. That is a deliberate exception to scope resolution and is bounded: a term statistic carries no memory id, no content, and no attribution, and it SHALL NOT be usable to return, count, or infer the existence of an individual row outside the caller's scope. No response field SHALL expose a raw term statistic.

#### Scenario: A five-memory instance still produces a defined level

- **GIVEN** an instance holding five memories, and a query whose terms all appear in all five
- **WHEN** the relevance level is computed
- **THEN** every term SHALL carry a positive weight, the level SHALL be defined, and it SHALL equal the unweighted coverage of the same query

#### Scenario: An empty index does not divide by zero

- **GIVEN** an instance with no memories at all
- **WHEN** a search is issued
- **THEN** the search SHALL complete without error and SHALL return nothing, and no term weight SHALL be zero or undefined

#### Scenario: A term the corpus has never seen weighs most

- **GIVEN** two candidate rows, one matching a query term that appears in nearly every memory and one matching a query term that appears in none of the others
- **WHEN** their relevance levels are compared
- **THEN** the row matching the rarer term SHALL score higher

#### Scenario: Term statistics are not a cross-scope read channel

- **WHEN** any response payload from any tool is inspected
- **THEN** no document frequency, document total, or per-term weight SHALL appear in it, and no scoped read SHALL return a row whose only path into the result was a term statistic

### Requirement: Term-statistics lookups MUST be keyed on the index's own terms

The relevance level looks a term up in the index's own statistics, so a token the tokenizer would never have produced finds no entry, receives the weight reserved for a term the corpus has never seen — the maximum — and the level silently treats the corpus's commonest word as its rarest. A term is therefore only safe to look up if the index itself produced it.

The terms whose document frequencies are read SHALL be obtained from the full-text index's own tokenizer, by tokenising the query text through an FTS5 table declared with that same tokenizer and reading the resulting terms back, in the same read that resolves their document frequencies. The application SHALL NOT reproduce the index's tokenizer in order to key that read.

Reproducing it is not merely undesirable, it is unavailable, and the requirement is written this way because the alternative was measured and does not exist. The index's rule disagrees with any application-side rule in at least three independent ways — which characters delimit a term, whether text is compared decomposed or precomposed, and whether case folding is per-codepoint or context-sensitive — and its diacritic-folding table is neither "fold everything" nor "fold nothing", so agreement cannot be recovered by choosing a folding option on either side. A rule that agrees on one set of scripts trades away another.

Because the terms come from the index's tokenizer, absence becomes evidence rather than inference. The read SHALL distinguish a term the index holds from a term it does not, explicitly, so that the maximum weight is applied because the index reported no such term and not because a lookup key was missing from a map. A term reported absent SHALL carry the maximum weight; that is the same rule as before, and it is only correct under this requirement.

The declaration of the tokenising table SHALL be derived from the shipped declaration of the full-text index, read from the database's own schema at startup, so that the two cannot be separately edited into disagreement. A declaration option the derivation does not recognise SHALL fail startup rather than be silently dropped: a tokenizer option carried by the index and not by the tokenising table would reintroduce exactly the divergence this requirement removes, and would do so invisibly.

The tokenising table SHALL store no text. It exists to produce terms, not to hold a copy of the query, and SHALL NOT write to the durable database.

**The row-membership half of the lexical component is NOT covered by this requirement, deliberately.** Deciding which of the query's terms a candidate row contains is a separate operation over the whole fused pool, and the two families priced for doing it through the index — tokenising the pool at query time, and reading the index's term-major structures — were measured at eight to twenty-nine times the change's own cost budget. The one term-major variant that measures under the budget does so only while a per-row cache holds about a single pool's worth of rows, and the reason is structural: a term-major read has the term constraint pushed down and decides document membership only afterwards, so its cost tracks the corpus rather than the pool, and one and the same pool measures forty-six times as expensive at a corpus-sized cache as at a pool-sized one. It therefore continues to use the application's own tokenisation, and the consequence SHALL be bounded rather than hidden: a disagreement there can only cause a term the row does contain to be counted as not covered, which lowers that row's lexical component. It SHALL NOT be able to produce the absent-term maximum weight, SHALL NOT raise any row's level, and SHALL leave the dense branch's contribution to the level untouched — so a row the lexical component under-counts is still reachable on its cosine. This asymmetry SHALL be stated wherever the lexical component is specified; it SHALL NOT be described as agreement.

There SHALL be ONE application-side tokenisation shared by the search path's row-membership test and the save-time candidate path, so those two cannot disagree about what a token is.

#### Scenario: A term the index holds resolves to its real document frequency

- **GIVEN** a corpus containing a word whose index term differs from what an application-side tokenisation of the same word would produce — a Greek word ending in a final sigma, or a Cyrillic word containing a precomposed accented character
- **WHEN** that word is issued as a query term and its weight is resolved
- **THEN** it SHALL resolve to the document frequency the index records for it, and SHALL NOT resolve to the weight of a term absent from the index

#### Scenario: A term the index has never seen is reported absent, not zero

- **GIVEN** a query containing a term no indexed row contains
- **WHEN** the term statistics for that query are read
- **THEN** the term SHALL appear in the result marked as absent, distinguishably from a term the index holds, and SHALL receive the maximum weight on that basis

#### Scenario: The tokenising table inherits the index's declared tokenizer

- **WHEN** the tokenising table is created
- **THEN** its tokenizer declaration SHALL have been read from the shipped declaration of the full-text index in the database's schema, and SHALL NOT be restated independently anywhere in the source

#### Scenario: An unrecognised declaration option fails startup

- **GIVEN** a full-text index whose shipped declaration carries a tokenizer option the derivation does not recognise
- **WHEN** startup derives the tokenising table's declaration
- **THEN** startup SHALL fail naming the option, and SHALL NOT proceed with an option silently omitted

#### Scenario: A row-side tokenisation disagreement can only under-count

- **GIVEN** a candidate row containing a query term whose application-side tokenisation differs from the index's
- **WHEN** that row's relevance level is computed
- **THEN** the term SHALL be counted as not covered, the row's lexical component SHALL be no higher than if the term were absent from the row, and the row's level SHALL still be at least its dense-branch cosine

#### Scenario: Query text is not written to the durable database

- **GIVEN** a sequence of searches
- **WHEN** the durable database file and its write-ahead log are inspected before and after
- **THEN** neither SHALL have grown on account of tokenising the queries, and no table in the durable schema SHALL hold the query text
