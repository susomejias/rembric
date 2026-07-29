## MODIFIED Requirements

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
