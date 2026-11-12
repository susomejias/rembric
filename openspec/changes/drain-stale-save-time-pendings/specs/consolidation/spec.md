## ADDED Requirements

### Requirement: The sweep MUST drain a pending judgment only when no current save-time channel would admit its pair

The deterministic sweep SHALL include a permanent stale save-time pending drain step. It SHALL run after the deadline-orphaning step, in the same throttled per-scope run (see "The consolidation sweep MUST run lazily on session start, throttled per scope"), with no LLM, no cron and no new trigger. On every run it SHALL evaluate pending pairs against whatever save-time detection rules are current in that build.

For each pending `memory_relations` row it examines, the step SHALL re-evaluate the specific pair directly, with the relation's `source_id` as the saved memory and its `target_id` as the candidate, exactly as save-time detection orients them:

- **lexical:** the overlap measure the lexical channel reports for that pair (see the `memory` capability, "Save-time lexical candidate scoring MUST increase with match quality"), compared with `LEXICAL_CANDIDATE_FLOOR`;
- **vector:** the similarity the dense channel derives from the cosine distance between the two stored embeddings, compared with `VEC_THRESHOLD`;
- **entity:** whether the two memories share ANY entity, meaning the same kind and value. Each endpoint's entity set SHALL be its stored entity links unioned with a fresh extraction of its own title and content by the current extractor, for the source AND for the target. A scan record with no links does not prove that a memory has no entities: the backfill worker records one when extraction fails.

The lexical measure, the vector distance-to-similarity mapping and both threshold comparisons SHALL each be ONE implementation in core, called by save-time detection and by the drain alike, so the two cannot diverge. Extracting that implementation SHALL NOT change the behaviour of the shipped save path.

The pair SHALL be orphaned ONLY when its lexical measure is below `LEXICAL_CANDIDATE_FLOOR`, AND its vector similarity is below `VEC_THRESHOLD`, AND it shares no extracted entity. The entity check SHALL deliberately ignore the rarity gate save-time detection applies (see the `memory-entities` capability, "Entity overlap MUST be a save-time conflict-detection channel"). Link counts drift as a corpus grows, and draining a genuine identifier-anchored contradiction is the worst failure this step can have. The pairs it drains are therefore a subset of the pairs no current channel would admit.

The re-check SHALL NOT depend on rank. A pair SHALL NOT be drained because its target falls outside today's per-channel candidate pool or outside the per-save cap: pending rows were created from the top of a capped, pool-bounded list, and a corpus that has grown since can push a genuine pair out of the pool while it still clears the floor.

The step SHALL NOT select or orphan rows by age. Age-based orphaning remains the job of "Aged pending relations MUST be deterministically orphaned after a deadline".

Each drain SHALL be a single `pending` → `orphaned` transition with `marked_by_kind = 'consolidator'`, applied in ONE transaction together with its `orphan_promote` journal op. The relation's `judged_at` and the op's `applied_at` SHALL carry ONE timestamp, taken once per drain and passed to both writes. That op SHALL record the relation as null, the judgment id as the created id, and a deterministic reasoning string distinct from the deadline step's. A row that is no longer `pending` when its transition is attempted SHALL be skipped. The step SHALL write no memory row and SHALL NOT change a `judged` or `orphaned` relation.

#### Scenario: A pair no channel admits is drained and journaled

- **GIVEN** a pending relation whose source and target are both active and share only common words, with a lexical measure below `LEXICAL_CANDIDATE_FLOOR`, a vector similarity below `VEC_THRESHOLD`, and no shared extracted entity
- **WHEN** the sweep runs for their scope
- **THEN** the relation SHALL become `orphaned` with `marked_by_kind = 'consolidator'`
- **AND** one `orphan_promote` op SHALL record `affected_ids = [source, target]`, the judgment id as `created_id`, and the drain's reasoning string

#### Scenario: A lexically admitted pair is kept

- **GIVEN** a pending relation whose lexical measure is at or above `LEXICAL_CANDIDATE_FLOOR`, and whose vector similarity is below `VEC_THRESHOLD` with no shared entity
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending` and no op SHALL reference it

#### Scenario: A vector-admitted pair is kept

- **GIVEN** a pending relation whose lexical measure is below the floor and whose stored embeddings yield a vector similarity at or above `VEC_THRESHOLD`
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

#### Scenario: A pair sharing any entity is kept, even one the rarity gate would block

- **GIVEN** a pending relation whose lexical measure is below the floor and whose vector similarity is below `VEC_THRESHOLD`, and whose endpoints share an extracted entity linked to more active memories than the rarity gate admits
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

#### Scenario: A pair outside today's pool and cap is still kept

- **GIVEN** a pending relation whose lexical measure is at or above the floor, in a scope where more than `CANDIDATE_POOL_SIZE` other memories now rank above its target for the source's text
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`, even though a fresh save of the source would not reach that target within its pool or its per-save cap

#### Scenario: Age does not decide a drain

- **GIVEN** two pending relations created at the same instant and younger than `JUDGMENT_ORPHAN_DEADLINE_MS`, one admitted by a channel and one admitted by none
- **WHEN** the sweep runs
- **THEN** only the unadmitted relation SHALL be orphaned by the drain step
- **AND** the admitted relation SHALL remain `pending` until a verdict or the deadline step closes it

#### Scenario: The drain changes no memory and no closed relation

- **GIVEN** a scope holding judged relations, orphaned relations and active memories, and a recorded hash of those rows
- **WHEN** the drain step runs and orphans at least one pending relation
- **THEN** the memory rows and every relation that was not `pending` SHALL hash identically to before

#### Scenario: The journal op and the transition land together

- **GIVEN** a pending relation the drain selects, and a journal insert forced to fail
- **WHEN** the drain step processes it
- **THEN** the relation SHALL remain `pending` and no `orphan_promote` op SHALL reference it

#### Scenario: Extracting the shared predicate leaves the save path unchanged

- **GIVEN** the save-time calibration sweep and the existing save-time candidate tests
- **WHEN** they run before and after the per-pair predicate is extracted
- **THEN** the sweep output SHALL be byte-identical and every existing test SHALL pass unedited

### Requirement: The drain MUST keep a pair whose admission cannot be evaluated

Each channel's verdict for a pair SHALL be one of "admitted", "not admitted" and "unknown". The drain SHALL orphan a pair only when all three verdicts are "not admitted". Any "unknown" SHALL keep the pair `pending`. A verdict SHALL be "unknown" whenever the step cannot evaluate it against current data, including when:

- either endpoint has no stored embedding (vector channel);
- the vector index does not match the current embedding recipe (vector channel, see "The drain MUST NOT invoke the embedding model");
- extracting entities from either endpoint throws (entity channel);
- either endpoint's title plus content is longer than `DRAIN_MAX_PAIR_CHARS` (every channel);
- either memory row cannot be read;
- the re-check throws for the pair.

`DRAIN_MAX_PAIR_CHARS` bounds the cost of one pair's evaluation, because `memory.save` accepts content of any length. It SHALL be a named constant, not operator-configurable. Its value SHALL be carried by a committed worst-case measurement, and SHALL NOT exceed the entity extractor's input bound, so every pair the drain evaluates is extracted in full. The lengths SHALL be read before the content is loaded. The size bound and the three channels apply only to pairs whose endpoints are both readable and `active`. A retired-endpoint drain needs neither the content nor the channels (see "The drain MUST orphan pairs whose endpoint is retired").

A pair kept as unknown SHALL be evaluated again when the cursor next reaches it. A failure of the step itself SHALL NOT fail the run: the run SHALL still finish with its decay and deadline counts, and the failure SHALL be logged.

#### Scenario: A pair with a missing embedding is kept

- **GIVEN** a pending relation whose lexical measure is below the floor and that shares no entity, and whose target has no row in the vector index
- **WHEN** the drain evaluates it
- **THEN** the vector verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: A pair whose re-check throws is kept

- **GIVEN** a pending relation for which the pair evaluation throws
- **WHEN** the drain step processes it
- **THEN** the relation SHALL remain `pending`, no op SHALL reference it, and the remaining pairs of the run SHALL still be evaluated

#### Scenario: An extraction failure keeps the pair

- **GIVEN** a pending relation that the lexical and vector checks do not admit, and an entity extraction that throws for its target
- **WHEN** the drain evaluates it
- **THEN** the entity verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: A target scanned without links is still checked by fresh extraction

- **GIVEN** a pending relation that the lexical and vector checks do not admit, whose target has an entity-scan record but no entity links, and whose target text contains an identifier the extractor recognises and the source also contains
- **WHEN** the drain evaluates it
- **THEN** the entity verdict SHALL be "admitted" and the relation SHALL remain `pending`

#### Scenario: An oversized pair is kept

- **GIVEN** a pending relation whose source title plus content is longer than `DRAIN_MAX_PAIR_CHARS`
- **WHEN** the drain evaluates it
- **THEN** it SHALL NOT load or tokenize that content, the verdict SHALL be "unknown", and the relation SHALL remain `pending`

### Requirement: The drain MUST NOT invoke the embedding model

The drain SHALL read only the vectors already stored in `memory_vec`, the same way save-time detection's dense channel reads them: it looks up each memory's stored embedding and compares the two with `vec_distance_cosine`. It SHALL NOT load the embedding model, call it, or enqueue an embedding, and it SHALL NOT embed a memory whose vector is missing. A missing vector, including every vector in the window after a model-identity reset has wiped the index and before it has been re-embedded, SHALL make the vector verdict "unknown", so the pair stays `pending`.

A stored vector is trustworthy only while the vector index matches the current embedding recipe. The identity reset that wipes stale vectors runs only when the embedder loads, and it can be deferred, so a sweep can meet vectors written under an older recipe. The runner SHALL therefore receive an injected predicate, `vectorIndexCurrent: () => boolean`, evaluated at the start of each drain step. When it returns false, every pair's vector verdict in that step SHALL be "unknown". The predicate is injected rather than imported, because the drain may not import the embedding layer.

This SHALL hold by construction:

- the consolidation runner SHALL receive no embedder or embedding function among its dependencies. The boolean `vectorIndexCurrent` predicate is its only embedding-related input;
- no module the drain imports, directly or transitively, SHALL import the embedding layer.

#### Scenario: The drain runs with the embedding model not loaded

- **GIVEN** a process in which the embedding model has never been loaded, a pending relation whose endpoints both have stored vectors, and a pending relation whose target has none
- **WHEN** the sweep runs for their scope
- **THEN** the drain SHALL complete without loading or invoking the model
- **AND** it SHALL evaluate the first relation from the stored vectors and SHALL keep the second `pending`

#### Scenario: A wiped vector index keeps every pair

- **GIVEN** a scope whose vector index was wiped by a model-identity reset and has not been re-embedded, and pending relations that neither the lexical nor the entity check admits
- **WHEN** the sweep runs
- **THEN** every such relation SHALL remain `pending`, and the run summary SHALL count them as kept as unknown

#### Scenario: A vector index that predates the current recipe keeps the pair

- **GIVEN** `vectorIndexCurrent` returning false, and a pending relation whose stored vectors yield a similarity below `VEC_THRESHOLD` and that the lexical and entity checks do not admit
- **WHEN** the drain evaluates it
- **THEN** the vector verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: The runner's dependencies carry no embedder

- **WHEN** the consolidation runner's constructor options and the drain's import graph are inspected
- **THEN** the options SHALL match their declared key set exactly, with `vectorIndexCurrent` as the only embedding-related key
- **AND** neither SHALL include an embedder, an embedding function or a module of the embedding layer

### Requirement: The drain MUST orphan pairs whose endpoint is retired

The drain SHALL orphan a pending relation whose source or target has been superseded or archived: the row exists and its `status` is not `active`. Save-time detection admits only `active` targets and runs only for an `active` saved row, so the current rules would never create such a pair. The lifecycle change that retired the endpoint has overtaken the question the pair asked.

The agent queue already withholds such a row (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). No agent can therefore ever judge it, and before this change only the deadline step or an operator could close it.

Such a drain SHALL be written exactly like a rules drain: one transaction per pair, an `orphan_promote` journal op, and the same undo path. Its reasoning SHALL carry its own prefix, so an operator can tell a retired-endpoint drain from a rules drain.

The fail-safe still applies. When an endpoint row cannot be read, because it is missing or the read throws, the pair SHALL be kept. Only a readable, non-`active` endpoint triggers this drain.

#### Scenario: A superseded source is drained

- **GIVEN** a pending relation whose source was superseded by a `topic_key` revision
- **WHEN** the sweep runs
- **THEN** the drain SHALL orphan it with the retired-endpoint reasoning prefix
- **AND** an `orphan_promote` op SHALL journal it in the same transaction

#### Scenario: An archived target is drained

- **GIVEN** a pending relation whose target has been archived
- **WHEN** the sweep runs before `JUDGMENT_ORPHAN_DEADLINE_MS`
- **THEN** the drain SHALL orphan it with the retired-endpoint reasoning prefix

#### Scenario: An undone retired-endpoint drain is not drained again

- **GIVEN** a retired-endpoint drain that an operator has undone, so the relation is `pending` again
- **WHEN** later sweeps run
- **THEN** the drain SHALL NOT orphan that relation again

#### Scenario: An unreadable endpoint keeps the pair

- **GIVEN** a pending relation whose endpoint row cannot be read
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

### Requirement: The drain MUST re-evaluate a pair only within its own project

The drain SHALL select pending relations whose source and target both belong to the swept project. Every read the re-check performs SHALL concern only the pair's two memories within that project: their status, lengths, title and content, embeddings and entity links. No row of another project SHALL influence whether a pair is drained or kept. One project's backlog SHALL NOT prevent another project from making progress in the same sweep call.

#### Scenario: Another project's memories do not keep a pair

- **GIVEN** a pending relation in project A that no channel admits, and a memory in project B that restates its source word for word and shares its entities
- **WHEN** the sweep runs for project A
- **THEN** the relation SHALL be orphaned

#### Scenario: One project's backlog does not starve another

- **GIVEN** project A holding more drainable pending relations than the shared drain budget allows in one call, project B holding one drainable pending relation, and an injected clock that exhausts the budget while project A is being drained
- **WHEN** one forced `runAll` sweeps project A and then project B in the same call
- **THEN** project B's drain step SHALL still examine at least one pair, and project B's drainable relation SHALL be orphaned in that call

### Requirement: The drain MUST be bounded per run and advance a persisted cursor with wrap-around

Batching is a requirement, not an optimisation. The sweep runs on the server's single Node thread, and its database calls are synchronous, so a run blocks every other request for as long as it lasts. A backlog SHALL therefore be processed only in bounded runs, never in one unbounded pass.

Two bounds apply, and both SHALL be named constants, not operator-configurable, with values carried by a committed measurement:

- **`DRAIN_ROW_CAP`:** the most relations one scope's drain step examines in one run.
- **`DRAIN_BUDGET_MS`:** the wall-clock budget of drain time for ALL drain steps of one sweep call, shared across the scopes that call runs. One sweep call is one session-start callback, which sweeps the session's project and the default project, or one forced `runAll`, which sweeps every project. The budget SHALL count only the time spent inside the call's drain steps: it starts when the first drain step begins, not when the run begins, it SHALL NOT run during the decay and deadline steps of the call's later scopes, and it SHALL be checked between pairs.

A drain step SHALL stop at its row cap or when the shared budget is spent, whichever comes first, and the next run of that scope SHALL resume from the cursor. Every drain step SHALL examine at least one examinable pair, even when the shared budget is already spent, so a slow host and a late scope still make progress. The drain's time in one call is therefore bounded by `DRAIN_BUDGET_MS` plus, per scope of that call, one pair and the step's fixed reads, each pair bounded by `DRAIN_MAX_PAIR_CHARS`. The budget's value SHALL leave room for those per-scope costs at the measured project counts.

Each drain SHALL commit in its own transaction, holding only that pair's orphan and journal writes. No transaction SHALL span several pairs, a run or the backlog. A failure therefore rolls back only the pair it happened on.

An examinable relation is a `pending` relation whose source and target both belong to the scope, whatever their lifecycle, and that no reverted drain op references. The step SHALL examine them in `(created_at, judgment_id)` order, starting after the key of the last relation the previous run of the same scope examined. It SHALL exclude relations a reverted drain op references inside its selection, so excluded relations never occupy the row cap. It SHALL record that cursor in a nested object of the run's existing `consolidation_runs.summary` JSON (see "The drain's outcome MUST be visible to the operator"), with no new table or column. When a run reaches the end of the examinable relations, the cursor SHALL wrap: the step SHALL continue from the lowest key, within the same run while its bounds allow, and otherwise the next run SHALL start from there. A run SHALL NOT examine a relation twice. A missing or unparsable cursor SHALL start from the lowest key.

Kept pairs at the head of the order SHALL therefore never prevent later pairs from being examined. Because every run examines at least one pair, every examinable relation SHALL be examined within `P` runs of its scope, where `P` is the scope's examinable count. When no run is cut short by the shared budget, that SHALL happen within `ceil(P / DRAIN_ROW_CAP)` runs.

A relation whose drain op an operator has reverted SHALL NOT be drained again by any later run of the drain. This finality binds the drain only. The deadline step's selection does not read the journal, so an undone relation that later crosses `JUDGMENT_ORPHAN_DEADLINE_MS` SHALL be orphaned by the deadline step like any other pending relation.

#### Scenario: A backlog larger than one run is covered without starvation

- **GIVEN** a scope whose lowest `(created_at, judgment_id)` keys belong to more kept pending relations than one run's row cap, followed by drainable ones
- **WHEN** the sweep runs repeatedly (manually forced, bypassing the throttle)
- **THEN** each run SHALL examine at most the row cap, the cursor SHALL advance past the kept relations, and the drainable relations SHALL be orphaned by a later run

#### Scenario: A backlog larger than the cap is processed across runs

- **GIVEN** a scope holding 5 000 drainable pending relations, more than `DRAIN_ROW_CAP`
- **WHEN** one run executes
- **THEN** it SHALL examine at most `DRAIN_ROW_CAP` relations and stop, leaving the rest `pending`
- **AND** each later run SHALL resume after the recorded cursor until all 5 000 have been examined

#### Scenario: A failure mid-run keeps the drains already committed

- **GIVEN** a run in which the orphan-and-journal write of the third drainable pair fails
- **WHEN** the drain step processes the batch
- **THEN** the first two pairs SHALL remain `orphaned`, each with its `orphan_promote` op
- **AND** the third SHALL remain `pending` with no op, and the run SHALL continue with the fourth

#### Scenario: The cursor wraps to the start

- **GIVEN** a cursor that has passed the highest pending key of the scope, and a pending relation that became drainable after the cursor passed it
- **WHEN** the next runs execute
- **THEN** the step SHALL continue from the lowest key, and that relation SHALL be orphaned once reached

#### Scenario: The wall-clock budget ends a run early and the next run resumes

- **GIVEN** an injected clock that starts when the drain step begins and exhausts `DRAIN_BUDGET_MS` after two pairs
- **WHEN** the drain step runs
- **THEN** it SHALL examine two pairs, record the second one's key as the cursor, and the next run SHALL begin with the third

#### Scenario: A slow host still progresses

- **GIVEN** a sweep call whose earlier drain steps have already spent the shared budget when a scope's drain step begins
- **WHEN** that drain step runs
- **THEN** it SHALL examine exactly one pair and record that pair's key as the cursor

#### Scenario: Time spent before the drain does not consume its budget

- **GIVEN** a run whose decay and deadline steps take longer than `DRAIN_BUDGET_MS`, and an injected clock that keeps running through them
- **WHEN** the drain step runs
- **THEN** it SHALL examine pairs up to its row cap or its own budget, not just the minimum single pair

#### Scenario: An operator's undo is final for the drain

- **GIVEN** a drained relation whose `orphan_promote` op the operator has undone, restoring it to `pending`
- **WHEN** the cursor reaches that relation again on a later cycle
- **THEN** the drain SHALL NOT orphan it again

#### Scenario: The deadline step still closes an undone relation

- **GIVEN** a drained relation whose drain op the operator has undone, and that later becomes older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the deadline step SHALL orphan it with its own reasoning string, and the drain SHALL NOT be the step that orphans it

### Requirement: Undoing an orphaning MUST NOT overwrite a verdict written after it

Undoing an `orphan_promote` op SHALL reset the relation to `pending`, and SHALL apply any `supersedes` side-effect reversal, ONLY when the relation has not been written since the op: its `judged_at` is non-null and not later than the op's `applied_at`. The drain stamps both with one timestamp, so its own write always passes this test.

The guard is needed because `memory.compare` writes its verdict onto an existing relation for the same pair whatever that relation's status, so an orphaned relation can be judged after the op that orphaned it. A `supersedes` verdict also supersedes the target and adds it to the source's `replaces`, and today's undo reverses exactly that side effect.

When `judged_at` is null, the relation cannot be shown to be the op's own write. If it is `pending`, there is nothing to restore. In every null case, the relation SHALL be left as it is.

A relation the undo leaves as it is SHALL be reported (judgment id, current status and current relation), the operator surface SHALL show that the undo was partial and why, and the op SHALL still be marked reverted. This guard applies to every `orphan_promote` op, historical ones included.

#### Scenario: Undo restores a drained relation to pending

- **GIVEN** a relation orphaned by the drain step and not written since
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** the relation SHALL return to `status = 'pending'` with `relation`, `reason`, `judged_at`, `marked_by_kind` and `marked_by_actor` cleared, and the op SHALL be marked reverted

#### Scenario: Undo keeps a supersedes verdict written after the drain

- **GIVEN** a relation between two active memories, orphaned by the drain step and later judged `supersedes` through `memory.compare` on the same source and target, so the target is `superseded` and the source's `replaces` contains it
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** the relation SHALL remain `judged` with relation `supersedes`, the target SHALL remain `superseded`, and the source's `replaces` SHALL still contain the target
- **AND** the undo result SHALL name its judgment id as not restored, and the op SHALL be marked reverted

#### Scenario: Undo leaves a relation with no judged_at untouched

- **GIVEN** an `orphan_promote` op whose relation has a null `judged_at`
- **WHEN** the operator undoes that op
- **THEN** the relation SHALL be left as it is and reported as not restored, and the op SHALL be marked reverted

### Requirement: The drain's outcome MUST be visible to the operator

Each run's summary SHALL record the drain's outcome inside ONE nested object under the key `drain`, holding:

- the cursor;
- the counts examined, drained by the rules, drained for a retired endpoint, kept as admitted, and kept as unknown.

The summary's top-level keys SHALL stay `archives` and `orphaned`, with their current meaning. `memory.doctor` passes only the summary's top-level finite numbers through to `lastRunOps`, so its published output SHALL NOT change.

The dashboard's run-detail summary SHALL show the drained count beside the archived and orphaned counts (see the `dashboard` capability, "Consolidation runs MUST be inspectable and reversible from the dashboard"). Every drain op SHALL be listed and undoable from the existing consolidation views, individually and as part of its run. Its reasoning string SHALL identify it as a rules drain or a retired-endpoint drain, distinct from a deadline orphaning.

#### Scenario: A run that drained shows it

- **GIVEN** a run whose drain step orphaned two relations by the rules and one for a retired endpoint
- **WHEN** the operator opens that run's detail page
- **THEN** the summary SHALL show three drained, and the three `orphan_promote` ops SHALL be listed with their reasoning strings and an undo control

#### Scenario: memory.doctor output is unchanged by the drain

- **GIVEN** the latest run drained at least one relation
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** `consolidation.lastRunOps` SHALL hold exactly the keys `archives` and `orphaned`

## MODIFIED Requirements

### Requirement: Every consolidation decision MUST be journaled

Every operation produced by the sweep — decay archive, deadline orphaning, or stale save-time pending drain — SHALL be recorded in `consolidation_ops` with the operation type, affected ids, a deterministic reasoning string, the resulting created id (when applicable), and the application status.

Deadline orphaning, rules drains and retired-endpoint drains SHALL all journal as `orphan_promote`, with the relation recorded as null and the judgment id as the created id. Each SHALL use its own reasoning prefix, so the three remain distinguishable.

Historical op types (`merge`, `supersede`) remain valid journal rows: they SHALL keep rendering in the dashboard and SHALL keep their undo semantics, but the sweep SHALL NOT produce new rows of those types. Historical `orphan_promote` rows that recorded a verdict SHALL keep rendering. Their undo SHALL follow "Undoing an orphaning MUST NOT overwrite a verdict written after it", which leaves unchanged every undo whose relation has not been written since the op.

#### Scenario: A decay archive is journaled

- **WHEN** the sweep archives memories A and B via decay
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'decay'`, `affected_ids = ['A','B']`, and a deterministic reasoning string

#### Scenario: A historical LLM-era op is still visible and undoable

- **GIVEN** a pre-upgrade `consolidation_ops` row with `op_type = 'merge'` whose referenced rows all exist
- **WHEN** the operator views the run and triggers undo for that op
- **THEN** the op SHALL render normally and the undo SHALL succeed exactly as before the upgrade

#### Scenario: Deadline and drain orphanings are distinguishable in the journal

- **GIVEN** one run in which the deadline step orphaned relation R1, the drain orphaned relation R2 by the rules, and the drain orphaned relation R3 for a retired endpoint
- **WHEN** the run's ops are listed
- **THEN** all three SHALL be `orphan_promote` ops, and their reasoning prefixes SHALL differ: R1's names the deadline, R2's the rules drain and R3's the retired-endpoint drain

### Requirement: The consolidation MUST be idempotent on stable input

Running the sweep twice with no intervening writes SHALL produce zero new operations beyond noops, except where a step's per-run bound left work for the next run. Specifically:

- the decay pass SHALL be a no-op if no row crossed the threshold since the previous run;
- the deadline-orphaning pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_DEADLINE_MS` since the previous run;
- the stale save-time pending drain MAY re-examine relations it kept, but on stable input it SHALL reach the same verdict and SHALL produce no op for a relation any earlier run examined and kept.

#### Scenario: Back-to-back sweeps with no intervening saves

- **GIVEN** a scope whose decay candidates, overdue pending relations and drainable relations all fit within one run's bounds
- **WHEN** the sweep runs twice in immediate succession (manual trigger bypassing the throttle)
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives, zero new orphanings and zero drains

#### Scenario: A re-examined kept pair stays kept

- **GIVEN** a scope whose every examinable pending relation fits within one run's row cap, after one drain run
- **WHEN** the sweep runs again with no intervening writes
- **THEN** the drain SHALL orphan zero relations
