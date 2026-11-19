## ADDED Requirements

### Requirement: Text-query search MUST be able to rerank the head of the fused pool with a cross-encoder

The text-query branch SHALL be able to reorder the head of its fused candidate pool with a cross-encoder: a model that reads the query and one candidate together and returns a single relevance score for the pair. Fusion ranks by position in two lists and the relevance level measures term coverage and vector distance; neither reads the query against the candidate's text, and on real data the cross-encoder placed a useful memory first far more often than the fused order did.

The model SHALL be `hindsight-ai/hs-rerank-1` at a pinned revision, run in-process with no network call, and its identity (model id, revision, ONNX artifact) SHALL be declared once and consumed by both the loader and the image build. Its raw output is one logit per pair; `rerankScore` SHALL be the logistic of that logit.

The **rerank window** SHALL hold `RERANK_WINDOW` rows of the fused pool, taken before the relative filter and before the ranking boost from the two retrievers' ranked lists: the dense retriever's first `RERANK_DENSE_SLOTS` rows, then the lexical retriever's rows in order, then the dense retriever's remaining rows, skipping a row already taken, until the window is full or both lists are exhausted. It SHALL NOT be the head of the fused order, and `RERANK_DENSE_SLOTS` SHALL be smaller than `RERANK_WINDOW`, so the lexical retriever's best rows always have a place. Reciprocal Rank Fusion scores a row by the sum of its reciprocal ranks, so a row only one retriever found sits below every row both found: measured, a query in one language whose answer is stored in another was the dense retriever's first row and the fused pool's seventeenth, behind rows that shared only function words with the query, so a window cut from the fused head never showed it to the model. Taking rows from each list directly gives each retriever's best rows a place in the window at the same inference cost. The dense list gets most of the window because a query whose answer is in another language reaches it only through the dense list, and on real data that answer was often not the dense list's first row but its sixth to tenth, behind same-language memories on other topics; the lexical list keeps the rest because a window without it measurably lost same-language answers. Each candidate SHALL be presented to the model as its `title` followed by its `content`, the same recipe the embedder reads, and each query-candidate pair SHALL be truncated to `RERANK_MAX_TOKENS` tokens. The stored memory, its embedding and its lexical index entry SHALL NOT be affected by that truncation: it bounds what the cross-encoder reads to order a row that the retrievers already found over its full text. The response page SHALL then be the window ordered by `rerankScore(id) * boost(id)` and truncated to `limit`.

A call is **eligible** only when all of these hold: it carries a non-empty text query; its `offset` is zero; its `limit` is at most `RERANK_WINDOW`; and neither abstention cause has spoken. Every other call SHALL be served by the unreranked path unchanged. Paging past the window is deliberately not reranked: the window is the only part of the pool the model has read, so a second page cannot be ordered consistently with the first.

`RERANK_WINDOW`, `RERANK_DENSE_SLOTS` and `RERANK_MAX_TOKENS` SHALL be named compile-time constants declared once in the module that owns reranking. None SHALL be operator-configurable or settable per request. Their shipped values SHALL be the ones a committed evaluation run supports, and a change to any of them SHALL re-run that evaluation in the same change, because both trade latency against ordering quality and the trade was measured rather than assumed.

Reranking SHALL NOT widen what a search can return. Every returned row SHALL be a row of the fused pool for the same query, scope and filters, so scope isolation, status and type filters, and cross-project rules hold on the reranked path by construction.

#### Scenario: The cross-encoder reorders the head of the pool

- **GIVEN** a query and a scope where the memory that answers it is fused at rank 4 behind three memories that only share its vocabulary
- **WHEN** `memory.search` serves the query on the reranked path
- **THEN** the answering memory SHALL be ordered by its cross-encoder score multiplied by its boost, and SHALL rank above the three when that product is higher

#### Scenario: A row only the dense retriever found reaches the model

- **GIVEN** a query whose answering memory is the dense retriever's first row, shares no term with the query, and sits below `RERANK_WINDOW` in the fused order behind rows the lexical retriever matched
- **WHEN** `memory.search` serves the query on the reranked path
- **THEN** the answering memory SHALL be in the rerank window, the window SHALL still hold the lexical retriever's first row, and the window SHALL hold no more than `RERANK_WINDOW` rows

#### Scenario: A row outside the fused pool is never returned

- **GIVEN** a memory in another project, or one excluded by the call's `status` or `type` filter
- **WHEN** `memory.search` serves a query on the reranked path
- **THEN** that memory SHALL NOT appear in the response, whatever score the cross-encoder would have given it

#### Scenario: A paged call is not reranked

- **WHEN** `memory.search` is called with a text query and a non-zero `offset`, or with a `limit` above `RERANK_WINDOW`
- **THEN** the response SHALL be the one the unreranked path returns for that call

#### Scenario: Truncation does not hide a memory from retrieval

- **GIVEN** a memory longer than `RERANK_MAX_TOKENS` whose only matching text lies beyond that length
- **WHEN** `memory.search` is called with a query matching that text
- **THEN** the memory SHALL still enter the fused pool through the retrievers, which read its full text

#### Scenario: The rerank constants are not request parameters

- **WHEN** any MCP tool input schema or the environment schema is inspected
- **THEN** neither `RERANK_WINDOW` nor `RERANK_MAX_TOKENS` SHALL be settable

### Requirement: Reranking MUST be requested by the calling surface, and automatic recall MUST NOT request it

Reranking SHALL be an explicit option of the search service that each calling surface either passes or omits; it SHALL NOT be a default of the service. A cross-encoder run costs tens of milliseconds per call where the fused search costs a few, so it belongs on the surfaces where an agent deliberately asks for the best order, and not on the ones that fire automatically and in bursts.

The surfaces that SHALL request it are `memory.search` and the ranked pass of `memory.context`'s relevance channel. The surfaces that SHALL NOT request it are the per-turn recall endpoint, file-anchored recall, and save-time candidate detection.

Reranking SHALL be on by default. The single operator setting that reaches it SHALL be `REMBRIC_RERANK`: the value `off` SHALL keep the reranker from being created at all (no model loaded, no worker, no boot timing), and every reranked surface SHALL then serve the unreranked order; any other value, or none, SHALL leave reranking on. It exists for hosts shared with other workloads, where the operator may prefer to keep the reranker's memory and CPU for them. Apart from that switch, a reranker that cannot serve a call degrades that call to the unreranked path (see "Reranker inference MUST run off the main thread and MUST be bounded by a deadline").

#### Scenario: An explicit search is reranked

- **WHEN** `memory.search` is called with an eligible text query
- **THEN** the call SHALL be served by the reranked path

#### Scenario: The per-turn recall endpoint is not reranked

- **WHEN** a client calls the per-turn recall endpoint
- **THEN** the search behind it SHALL NOT request reranking and no cross-encoder inference SHALL run for that call

#### Scenario: The operator switches reranking off

- **GIVEN** a server started with `REMBRIC_RERANK=off`
- **WHEN** `memory.search` is called with an eligible text query
- **THEN** the response SHALL be the unreranked one, and no reranker model SHALL have been loaded

#### Scenario: Only the switch reaches reranking

- **WHEN** every environment read of the server is inspected
- **THEN** `REMBRIC_RERANK` SHALL be the only one that reaches reranking, and none SHALL change its window, its token cap or its deadline

### Requirement: Reranker inference MUST run off the main thread and MUST be bounded by a deadline

Cross-encoder inference, including tokenization of its input, SHALL run in one dedicated worker thread that owns the reranker model. The thread serving HTTP SHALL NOT run it. Measured in-process, a rerank blocked the event loop for its whole duration, which stalled every other request, and tokenizing on the serving thread reintroduced stalls of over a hundred milliseconds under a burst.

There SHALL be exactly one such worker. Its requests SHALL be served one at a time in arrival order. A pool of several workers SHALL NOT be introduced without a new measurement: a second worker added roughly 600 MB of resident memory for about a fifth less latency at eight concurrent searches, and a fourth was no faster than a third.

Every reranked call SHALL carry a deadline, `RERANK_DEADLINE_MS`, measured from the moment the request is handed to the worker and covering both its time in the queue and its inference. A call whose deadline passes SHALL **fall back**: it SHALL return exactly the response the unreranked path produces for the same call, and its late result SHALL be discarded. The same fallback SHALL apply when the model has not finished loading, failed to load, or the worker has exited. A request whose deadline passed while it waited in the queue SHALL be dropped by the worker without running inference, so a burst cannot build a backlog that makes every later call miss its deadline too. The worker SHALL NOT be terminated while it runs inference: measured, terminating the thread mid-inference aborted the whole process, so stopping it SHALL ask it to exit after its current request. A fallback is not an error: the response SHALL NOT carry an error, and the failure SHALL be logged and counted.

The worker SHALL be started and its model loaded outside any request, so a first reranked call does not pay the model load. A worker that exits SHALL be restarted, with the restarts bounded so a model that cannot load does not respawn in a loop.

Once the model is loaded and no embedding backlog remains, the server SHALL time one full rerank window, and that measurement SHALL calibrate the reranker. When the window cannot finish within `RERANK_DEADLINE_MS`, the reranker SHALL **stand down**: its worker SHALL be asked to exit and every later eligible call SHALL fall back at once, without waiting for a deadline. While it stands down, the server SHALL load it and time a full window again every 15 minutes, and SHALL keep it once a window fits: on a host shared with other workloads a busy moment at boot would otherwise switch reranking off until the next restart. Measured at one vCPU, a full window took 393 ms, so every reranked search waited 300 ms and then served the unreranked order anyway. When the window fits, a call SHALL fall back at once, without being queued, whenever the calls already in flight plus itself, each costing one measured window, could not finish within the deadline: a queued call that would miss its deadline only adds that wait to a search that serves the unreranked order anyway. Before the measurement, calls SHALL be queued as described above. A reranker whose window fits SHALL NOT be re-timed, and there SHALL be no smaller window or token cap chosen by hardware.

#### Scenario: A rerank does not block other requests

- **GIVEN** a reranked search in flight
- **WHEN** another request arrives on the same server
- **THEN** it SHALL be served without waiting for the rerank to finish

#### Scenario: A burst falls back instead of queueing without bound

- **GIVEN** more simultaneous eligible searches than the worker can serve within `RERANK_DEADLINE_MS`
- **WHEN** a queued call's deadline passes
- **THEN** that call SHALL return the unreranked response for its query, with no error, and SHALL be counted as a fallback

#### Scenario: A CPU too slow for one window stands the reranker down

- **GIVEN** a server whose boot measurement of a full window does not finish within `RERANK_DEADLINE_MS`
- **WHEN** `memory.search` is called with an eligible text query
- **THEN** the response SHALL be the unreranked one, returned without waiting for the deadline, and the worker SHALL have been asked to exit

#### Scenario: A stood-down reranker comes back when the CPU frees up

- **GIVEN** a reranker that stood down
- **WHEN** a later timing of a full window, taken 15 minutes after the previous one, finishes within `RERANK_DEADLINE_MS`
- **THEN** eligible searches SHALL be reranked again and no further timing SHALL run

#### Scenario: A search that cannot be served in time is not queued

- **GIVEN** a calibrated reranker whose calls already in flight, plus one more, would exceed `RERANK_DEADLINE_MS` at one measured window each
- **WHEN** another eligible search arrives
- **THEN** it SHALL return the unreranked response at once, without being handed to the worker, and SHALL be counted as a fallback

#### Scenario: A reranker that cannot load does not fail search

- **GIVEN** reranker artifacts that are missing or corrupt
- **WHEN** `memory.search` is called with an eligible text query
- **THEN** the response SHALL be the unreranked one and the load failure SHALL be logged

#### Scenario: An expired request is not run

- **GIVEN** a reranked call whose deadline passes while it is still queued behind another request
- **WHEN** the worker reaches it
- **THEN** the worker SHALL reply without running inference, and the call SHALL already have fallen back

#### Scenario: A late result is discarded

- **GIVEN** a call that already fell back at its deadline
- **WHEN** the worker later finishes that call's inference
- **THEN** the result SHALL be discarded and SHALL NOT alter any response

## MODIFIED Requirements

### Requirement: Memory search MUST implement standard hybrid retrieval on the text-query branch

When `memory.search` is called with a non-empty text `query`, the system SHALL implement the standard hybrid-search pattern used by mainstream search engines: run an independent **lexical retriever** (FTS5/BM25 ranked ids) and **dense retriever** (vector k-nearest-neighbor ranked ids), then combine their ranked lists using Reciprocal Rank Fusion (RRF): `score(id) = Σ 1/(rank_constant + rank_branch(id))` over the branches in which the id appears. Each child retriever SHALL over-fetch into a bounded **rank window** (at least `limit + offset`, clamped to a fixed ceiling set strictly above the maximum `limit` so an unbounded `offset` cannot force a near-full partition scan) so that fusion is not artificially recall-capped. When `memory.search` is called WITHOUT a text `query`, the system SHALL use the existing chronological listing path unchanged (ordered by `created_at`, with exact `limit`/`offset`). The dense branch SHALL NOT apply a similarity threshold — fusion orders results, it does not filter them. The text query SHALL be sanitized before it is passed to the FTS5 `MATCH` so that an arbitrary natural-language query cannot raise an FTS5 syntax error or be reinterpreted as an FTS5 query expression. The sanitizer SHALL keep whole Unicode word tokens (it SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII — e.g. accented or CJK text), SHALL strip FTS5 metacharacters and balance quotes, and SHALL neutralize FTS5 bareword operators (`AND`, `OR`, `NOT`, `NEAR`) so a phrase like "coffee OR tea" matches literal terms rather than being parsed as a boolean expression. (The FTS tokenizer folds SOME diacritics and not others — measured, its folding table covers `migración` → `migracion` but leaves `phở`, `αναζήτηση` and `ǻrsrapport` accented — so an ASCII-folded token matches accented stored content on some scripts and not on others, and the sanitizer SHALL NOT attempt to close that gap: the binding requirement is to preserve whole tokens and neutralize operators. Where a lookup key must match the index's terms exactly, it is read back out of FTS5 instead — see "Term-statistics lookups MUST be keyed on the index's own terms".) A failure of either branch SHALL degrade gracefully to the other branch rather than failing the whole search. Filters SHALL have explicit guarantees: `status` and `type` apply to BOTH branches; `tag` is exact on the lexical branch and post-filters dense candidates inside the bounded rank window (so no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window rather than globally complete). Result rows SHALL carry the same shape as today (including the `relations` array). Search SHALL NOT advance `last_seen_at` for any returned row — see "Being returned by a search MUST NOT be sufficient to confer durability".

After RRF produces the fused, ordered candidate pool for the over-fetched rank window, the system SHALL apply a post-fusion multiplier BEFORE truncating to the top `limit` results: `finalScore(id) = rrfScore(id) * boost(id)`, where `boost(id)` is a compile-time-constant function of the candidate row's `confirmationCount`, time since `last_seen_at`, and `type`, clamped to a fixed range (declared `[0.7, 1.4]`; reachable in practice `[0.9, 1.35]` given the current per-signal weights). Applying the boost before truncation is deliberate: it CAN and is meant to change which rows make the page — a fresh, confirmed memory SHALL be able to outrank a stale unconfirmed one at a close raw RRF score. The clamp bounds the multiplier's magnitude; it does not, and is not meant to, prevent reordering near-ties. This boost applies ONLY to the text-query (fused hybrid-search) branch; the no-query chronological listing path is UNCHANGED and continues to use exact chronological order with no boost applied. The boost multiplier SHALL NOT be exposed as a per-request tunable — it is a fixed constant, matching the existing style of `RANK_CONSTANT` and the rank-window ceiling.

On a call that requests reranking and is eligible for it (see "Text-query search MUST be able to rerank the head of the fused pool with a cross-encoder"), the multiplier's left operand changes for the rows of the rerank window and for nothing else: `finalScore(id) = rerankScore(id) * boost(id)`, where `rerankScore(id)` is the cross-encoder's score for that row against the query, in `[0,1]`. The boost itself, its inputs, its clamp and its position before truncation SHALL be unchanged, because recency, confirmation count and type are not properties a text-pair model can read: measured on real data, ordering by the cross-encoder score alone lost the most-recent-decision ordering the boost provides. A call that does not request reranking, is not eligible for it, or falls back from it SHALL be scored by `rrfScore(id) * boost(id)` exactly as described above.

#### Scenario: A cross-lingual query surfaces a memory stored in another language

- **GIVEN** an `active` memory whose content is in English (e.g. "user prefers black coffee, no sugar")
- **WHEN** `memory.search` is called with a Spanish query expressing the same meaning (e.g. "¿cómo toma el café?") in the same scope
- **THEN** the FTS branch SHALL NOT raise a syntax error on the punctuation/accents, and the English memory SHALL appear in the fused results via the vector branch even though no query terms overlap lexically

#### Scenario: An exact proper-noun query ranks the lexical match

- **GIVEN** an `active` memory containing a proper noun or identifier (e.g. "Sobrino de Botín")
- **WHEN** `memory.search` is called with a query containing that exact token (e.g. "Botín")
- **THEN** the lexically-matching memory SHALL be ranked highly in the fused results via the FTS branch

#### Scenario: A memory consensually ranked by both branches wins

- **GIVEN** two `active` memories where one is surfaced by BOTH the vector and FTS branches and another by only one branch
- **WHEN** the two ranked lists are fused with RRF
- **THEN** the memory present in both branches SHALL receive the higher fused score, all else equal

#### Scenario: A memory without an embedding is still found lexically

- **GIVEN** an `active` memory whose embedding has not yet been computed (inline embed failed, drain lag, or mid-backfill)
- **WHEN** `memory.search` is called with a text query that lexically matches it
- **THEN** the memory SHALL appear in the fused results via the FTS branch, and search correctness SHALL NOT depend on full embedding coverage

#### Scenario: Archived text-query search degrades to lexical only

- **GIVEN** an `archived` memory still present in storage
- **WHEN** `memory.search` is called with `status = 'archived'` and a text query that lexically matches it
- **THEN** the lexical branch SHALL still be allowed to return it
- **AND** the search SHALL NOT require a vector hit for correctness because archived rows are outside the semantic-search guarantee after model changes

#### Scenario: The no-query listing branch keeps exact pagination

- **WHEN** `memory.search` is called WITHOUT a text query and with `limit` and `offset`
- **THEN** the results SHALL be the chronological listing with exact SQL `LIMIT`/`OFFSET` semantics, identical to prior behavior
- **AND** no post-fusion boost SHALL be applied (the boost only applies to the fused hybrid-search branch)

#### Scenario: BREAKING — offset is best-effort on the hybrid branch

- **WHEN** `memory.search` is called WITH a text query and a non-zero `offset`
- **THEN** `offset` SHALL be applied best-effort over the in-memory fused result pool (which is over-fetched beyond `limit + offset`) rather than as a SQL `OFFSET`; an `offset` beyond the fused pool SHALL yield an empty page rather than an error, and this divergence from the listing branch SHALL be documented as a contract change

#### Scenario: A heavily-confirmed fresh memory outranks a stale unconfirmed one within the fused pool

- **GIVEN** two `active` memories both present in the fused RRF pool with close raw RRF scores, one confirmed multiple times and recently seen, the other never confirmed and not seen in months
- **WHEN** `memory.search` applies the post-fusion boost
- **THEN** the confirmed, recently-seen memory SHALL rank at or above the other, but the reordering SHALL NOT move a memory absent from the fused pool into the returned results (the boost reorders the pool; it does not expand it)

#### Scenario: A reranked call keeps the post-fusion boost

- **GIVEN** two `active` memories in the rerank window with close cross-encoder scores, one confirmed several times and recently seen, the other never confirmed and not seen in months
- **WHEN** `memory.search` serves the query on the reranked path
- **THEN** the confirmed, recently-seen memory SHALL rank at or above the other, and the multiplier applied to each SHALL be the same `boost(id)` the unreranked path applies

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

On a call served by the reranked path (see "Text-query search MUST be able to rerank the head of the fused pool with a cross-encoder") the two gates part ways, and the split is contracted rather than incidental. The **floor** and the **empty-pool verdict** SHALL be evaluated exactly as above, over the whole fused pool, BEFORE any reranking work is done, so an abstaining query costs no inference. The **relative filter** SHALL NOT remove any row from the rerank window, and such a response SHALL NOT report `gateShortened`: the filter exists to drop rows the level judges far below the leader, and on this path a stronger judge of the same question reads those rows next, so filtering first would only withhold candidates from it. Measured on real data, reranking the unfiltered head of the pool scored higher than reranking the filtered one. A call that falls back from the reranked path SHALL have both gates applied as on any unreranked call, and its `gateShortened` SHALL be reported under the three conditions above. The cross-encoder score SHALL NOT be used as an abstention gate: on real data the best score of an answerable query fell below the best score of an unanswerable one, so no threshold over it separates the two.

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

#### Scenario: The relative filter does not thin the rerank window

- **GIVEN** the relative filter is enabled, and a fused pool whose first rows include some below `ratio × leaderLevel`
- **WHEN** `memory.search` serves the query on the reranked path
- **THEN** every row of the rerank window SHALL be scored by the cross-encoder, including the rows the filter would have removed
- **AND** the response SHALL NOT report `gateShortened`

#### Scenario: An abstaining query is not reranked

- **GIVEN** a text query whose fused pool is empty, or whose leader is below an enabled floor
- **WHEN** `memory.search` is called with reranking requested
- **THEN** the response SHALL report the same abstention verdict and reason as the unreranked path, and no cross-encoder inference SHALL run
