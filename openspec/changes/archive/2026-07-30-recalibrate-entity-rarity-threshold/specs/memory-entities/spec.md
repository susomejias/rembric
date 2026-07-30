## MODIFIED Requirements

### Requirement: Entity overlap MUST be a save-time conflict-detection channel

Two memories can contradict each other while sharing almost no vocabulary and sitting far apart in embedding space — a fix and its reversal, stated in different words about the same file. Lexical and dense similarity both miss that case. A newly saved memory sharing a sufficiently rare entity with an existing active memory in the same scope SHALL therefore be eligible as a save-time candidate, alongside the existing lexical and dense channels.

Candidates surfaced this way SHALL carry a source identifying the entity channel, so the agent judging them knows why they were proposed. An entity common enough to occupy the whole per-save candidate budget SHALL NOT generate candidates.

Rarity SHALL be measured over the population candidates are drawn from. BOTH sides of the proportion — the per-entity link count and the scope total it is divided by — SHALL count only memories whose `status` is `active`, excluding `superseded` and `archived` rows alike. Counting non-`active` rows is not a conservative approximation of that measurement, because a non-`active` row is never returned as a candidate: it makes the gate reject entities that cannot distort anything.

What the gate protects is COMPOSITION, not volume. Volume is bounded unconditionally by the per-save candidate maximum, gate or no gate. Composition is bounded by nothing else: entity-sourced candidates lead the merged list (see below), so a ubiquitous entity takes every slot and the lexical and dense channels contribute nothing. Only a memory that can OCCUPY a slot can starve another channel, and only an `active` memory can occupy one — which is what makes the `active` population derivable from the gate's purpose rather than merely asserted.

That population is load-bearing rather than pedantic, because the non-`active` population grows without bound. A `superseded` memory is never physically purged while a successor references it, and `topic_key` convergence concentrates a long-lived topic's entire superseded chain onto the SAME entity values — the same path, the same error code. Measuring rarity over non-`active` rows therefore drives the proportion up in proportion to a topic's age, and the channel SHALL NOT become inert on an evolving topic for that reason.

The same reasoning bounds the gate from the other side, and this bound SHALL be applied before the proportion is consulted. An entity whose `active` link count is below a named compile-time minimum SHALL be admitted regardless of its proportion, because an entity linked to fewer `active` memories than the per-save candidate budget holds cannot occupy that budget BY ITSELF, so blocking it serves no purpose this requirement states.

**That reasoning is per entity and does NOT extend to the aggregate, and this requirement SHALL NOT be read as claiming it does.** The gate is evaluated per entity while the budget is shared, and entity-sourced candidates lead unconditionally, so several separately-exempt entities extracted from one save MAY together occupy every slot. Measured at the shipped defaults: on a six-memory scope, five distinct one-link entities — each blocked before the minimum existed (`1/6 = 0.167 > 0.15`) and each exempt after it — fill all five slots and displace an FTS hit on a byte-identical duplicate. This is the same proportion-versus-shared-budget defect the composition follow-up owns, reached through many sparse entities rather than one ubiquitous one, and it is recorded here as a known consequence rather than left to be discovered. Bounding the entity channel's share of the budget belongs at the merge step and is deferred with the rest of that defect.

That minimum SHALL be a compile-time constant, fixed at the per-save candidate maximum's DEFAULT, and SHALL NOT be read from the operator's per-save maximum at request time. That setting is environment-configurable and may be zero; an admission rule that followed it would be operator-settable, and at zero would invert into a gate that always applies.

Without that precondition the proportion misfires on precisely the scopes where convergence help matters most. Comparing `linkCount / activeCount` against a fixed threshold blocks whenever the active count is below `linkCount / threshold`, so at a threshold of `0.15` a single link blocks every scope holding six or fewer `active` memories: a project's first few memories gate every entity they carry, and the channel is off exactly while a corpus is young. The precondition SHALL confine the proportion to the range where it can express something, and by construction can only change a decision for an entity below the link minimum — which bounds its effect to small scopes rather than trading away the gate at scale.

The proportion form does NOT, by itself, keep bounding composition as a corpus grows, and this requirement SHALL NOT be read as claiming that it does. A fixed proportion admits a link count that rises with the `active` population while the per-save budget stays fixed, so above an `active` count of `budget / threshold` a single admitted entity may still fill every slot. That residual gap is a property of comparing a proportion against a fixed-size shared budget, not of any particular threshold value, and closing it requires bounding the entity channel's share of the merged list rather than choosing a different threshold.

The three channels are merged into one list by a reported `similarity`, so that number SHALL be ONE quantity in every channel. Entity rarity SHALL NOT be that quantity. Rarity is the channel's ADMISSION gate — it decides whether the entity proposes anything at all — and reporting `1 - linkCount / scopeMemoryCount` as the similarity made a once-linked entity in a large scope report a near-1 score purely because the scope was large, outranking any realistic cosine and re-introducing the corpus-size dependence that was already removed from the lexical side. Every channel SHALL therefore report the same bounded `[0,1]` measure of how alike the two memories' text is: cosine where the dense branch found the pair, query-token containment otherwise.

Because that measure is near zero for exactly the pairs this channel exists to find, the channel's precedence SHALL be explicit rather than expressed through its score: entity-sourced candidates SHALL lead the merged list, and a target found by both the entity channel and another SHALL be reported as the entity one, because only that form carries the shared identifier. Ranking the channel on the shared measure alone would push its whole reason for existing past the per-save cap, behind candidates the other two channels would have surfaced anyway.

#### Scenario: A contradiction about the same file is surfaced

- **GIVEN** an active memory stating one approach for a specific file, and a new memory stating an incompatible approach for the same file, with little shared vocabulary
- **WHEN** the new memory is saved
- **THEN** the existing memory SHALL be surfaced as a candidate with the entity channel as its source

#### Scenario: A very common entity generates no candidates

- **GIVEN** an entity linked to a large share of the scope's active memories, and to at least as many of them as the compile-time link minimum
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: A young scope is not gated into silence

- **GIVEN** a scope holding three `active` memories, exactly one of them linked to an entity, so that the entity's share of the `active` population exceeds the rarity threshold while its link count is below the compile-time link minimum
- **WHEN** a new memory linked to that same entity is saved
- **THEN** that memory SHALL be surfaced as a candidate with the entity channel as its source

#### Scenario: The link minimum does not exempt an entity that reaches it

- **GIVEN** an entity whose `active` link count is exactly the compile-time link minimum, in a scope where those links are a large share of the `active` population
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: The gate measures the active population, not the non-archived one

- **GIVEN** a scope holding roughly as many `superseded` memories as `active` ones, and an entity whose links are all on `active` memories, at or above the compile-time link minimum, and amount to a large share of the `active` population, while amounting to a share of the scope's non-archived memories that is below the rarity threshold
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
