# memory — delta

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

Abstention has exactly **two** causes, and the response SHALL name which one spoke. The floor is one. The other is an **empty fused pool**: when both retrieval branches return no candidate at all, the response SHALL report `abstained: true` with a reason string DISTINCT from the floor's, because attributing the verdict to a gate that did not run is a false statement about the search. This verdict is a property of the POOL, not of the returned page, and SHALL NOT be inferred from an empty response: an `offset` beyond a NON-empty pool yields an empty page (see "BREAKING — offset is best-effort on the hybrid branch") and SHALL keep reporting `abstained: false`, because candidates existed and the caller paged past them. A reader who takes "empty response implies abstention" away from this requirement has read it wrong.

The empty-pool verdict is NOT a gate. It SHALL hold whatever the gates' shipped state, SHALL require no relevance level to be computed, and SHALL add no database read — an empty pool is observable from the fused candidate list already in hand. It applies to the text-query branch only: the exact-address entity branch and the no-query chronological listing SHALL continue to report `abstained: false` on an empty result, the former because it has its own index-lag signal and no relevance level, the latter because it paginates exactly and an empty page there is an ordinary end of list.

A page shortened by the relative filter SHALL NOT be padded to the requested limit, and SHALL report `abstained: false` — abstention is the floor's verdict or the empty pool's, and a caller MUST be able to tell "nothing relevant exists" from "fewer than `limit` rows were relevant". Because `abstained: false` alone cannot make that second distinction, the branch SHALL additionally report **`gateShortened`** when, and only when, ALL THREE hold: the relative filter removed at least one row from the fused pool, AND the returned page holds fewer rows than the requested limit, AND the requested `offset` still falls inside the fused pool. All three conditions are load-bearing. Without the removal condition, a page short because the pool itself was small would falsely blame the gate. Without the shortness condition, a full page sliced out of a heavily-filtered pool would carry a signal about rows the caller was never going to receive on this page. Without the offset condition, a page the caller emptied by paging past every candidate — one the ungated branch would have returned empty too — would blame the gate for an emptiness it did not cause. Together they answer the one question a short page raises: whether paging further or widening the query could recover anything the gate withheld.

`gateShortened` and the empty-pool abstention SHALL NOT both be reported for the same response, and this SHALL hold by construction rather than by an added check: the relative filter always retains the pool leader, so a non-empty pool yields a non-empty filtered pool, and an empty pool gives the filter nothing to remove.

Each gate is independently enabled or disabled, and the shipped state of each is recorded once, in "Retrieval and lifecycle constants MUST be named and bounded in one place", so that this requirement does not have to be edited whenever a constant moves. While BOTH gates are disabled the branch SHALL perform no gate-related work at all: it SHALL issue the same queries and return the same result ids as if the gates did not exist, and SHALL report no `gateShortened` — a disabled filter removes nothing. While EITHER gate is enabled the branch SHALL compute levels for the whole fused pool, and the cost of doing so SHALL be measured against a stated budget at 1 000, 20 000 and 50 000 memory rows before the enabling change lands.

#### Scenario: A question-shaped query is not carried by its function words

- **GIVEN** a scope whose memories all contain the terms `how`, `does`, `the` and `for`, none of which answers the query, and a query composed of those terms plus one term absent from the scope
- **WHEN** the relevance level of the best-matching row is computed
- **THEN** it SHALL be lower than the level of a row in the same scope that contains the query's absent term, and the difference SHALL come from the weighting rather than from the number of terms matched

#### Scenario: A query with nothing relevant abstains

- **GIVEN** the floor is enabled with a calibrated value, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: An empty fused pool abstains with its own reason

- **GIVEN** a text query for which both retrieval branches return no candidate — for example a `type` filter matching no row in scope, or an empty scope
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results, SHALL report `abstained: true`, and SHALL carry a reason string that is NOT the floor's reason
- **AND** the verdict SHALL be reached with both gates disabled, without computing any relevance level

#### Scenario: An empty page over a non-empty pool is not an abstention

- **GIVEN** a text query whose fused pool holds candidates, and an `offset` past the last of them
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report `abstained: false`, carrying no reason
- **AND** the same query at `offset: 0` SHALL return results, proving the pool was non-empty

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
- **AND** the response SHALL report `gateShortened`

#### Scenario: A short page is distinguishable from an abstention

- **GIVEN** the relative filter is enabled and it drops every row but two, while the leader clears the floor
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the response SHALL contain two results and SHALL report `abstained: false`
- **AND** the response SHALL report `gateShortened`, so the two rows are distinguishable from a scope holding only two candidates

#### Scenario: A full page over a filtered pool reports no shortening

- **GIVEN** the relative filter is enabled and it removed rows from a pool that still holds at least `limit` survivors
- **WHEN** `memory.search` is called with that limit
- **THEN** the response SHALL contain exactly `limit` results and SHALL NOT report `gateShortened`

#### Scenario: A short page the gate did not cause reports no shortening

- **GIVEN** a text query whose fused pool holds fewer rows than the requested limit and from which the relative filter removes nothing
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain every pool row, SHALL report `abstained: false`, and SHALL NOT report `gateShortened`

#### Scenario: A page paged past the whole pool reports no shortening

- **GIVEN** the relative filter is enabled and it removed rows from a pool, and an `offset` at or past the end of that fused pool
- **WHEN** `memory.search` is called
- **THEN** the response SHALL be empty, SHALL report `abstained: false`, and SHALL NOT report `gateShortened` — the ungated branch returns that same empty page, so the gate is not its cause
- **AND** an `offset` past the filter's survivors but still inside the fused pool SHALL report `gateShortened`, because there the ungated page would have held rows

#### Scenario: Abstention is off by default

- **GIVEN** both the floor and the relative filter are disabled
- **WHEN** `memory.search` is called
- **THEN** the text-query branch SHALL return the same result ids it returns with the gates removed, returning up to the requested limit, and SHALL issue no additional database read on their behalf — neither the pool's text nor any term statistic
- **AND** no response SHALL report `gateShortened`
- **AND** a query whose fused pool is empty SHALL still report `abstained: true` with the empty-pool reason
