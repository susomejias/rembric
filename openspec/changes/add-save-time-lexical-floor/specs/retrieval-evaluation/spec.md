## ADDED Requirements

### Requirement: The harness MUST provide a reproducible save-time calibration sweep for the lexical candidate floor

The ranked retrieval metrics cannot calibrate a save-time threshold. They observe the search path, not save-time candidate decisions, and the retrieval corpus carries no labelled duplicate or contradiction pairs. The harness SHALL therefore provide a separate save-time sweep, invocable as a documented command, that carries the value of the `memory` capability's `LEXICAL_CANDIDATE_FLOOR`.

**Fixture.** The sweep SHALL run over a committed fixture that is separate from the retrieval corpus and query set, so that running or extending it moves no retrieval baseline. The fixture SHALL hold:

- a heterogeneous base corpus, mixing at least English and Spanish, and mixing memory types and text lengths;
- a sequence of labelled saves in four classes:
  - **near-duplicate:** the same fact in reworded or lightly edited words;
  - **expanded rewrite:** the same fact with substantially more text;
  - **contradiction:** an incompatible statement about the same identifier, in different words;
  - **unrelated:** a fact absent from the base corpus.

Every class except unrelated SHALL name the base memory it is expected to surface.

**Method.**

- Each labelled save SHALL go through the same production curation path as `memory.save`: embedding, candidate detection, pending-row creation and entity linking. It SHALL NOT go through a reimplementation of that path.
- The sweep SHALL run across a committed grid of floor values from `0` to at least `0.95`, at a step no coarser than `0.05`.
- It SHALL run in two arms:
  - **lexical-only:** no embedder, which is the degraded mode when inference fails;
  - **production:** the compiled-in embedder.

**Output.** At every grid point, for each arm, the sweep SHALL report:

- the labelled pairs surfaced, per class;
- the pending rows written per unrelated save, split by candidate `source`;
- the total pending rows written over all labelled saves. This total is the queue-depth instrument, named as such on every row of the output.

The `0` grid point reproduces rank-only admission, so it SHALL be reported as the before-measurement of any floor value.

Like every other harness output, the sweep SHALL be deterministic on unchanged inputs.

#### Scenario: The sweep reports every axis at every grid point

- **WHEN** the save-time sweep is run
- **THEN** for each grid value and each arm it SHALL report the labelled pairs surfaced per class, the pending rows per unrelated save by `source`, and the total pending rows written

#### Scenario: The zero floor is the baseline

- **WHEN** the save-time sweep is run
- **THEN** its `0` grid point SHALL write the same pending rows as detection with rank-only lexical admission over the same fixture

#### Scenario: The fixture moves no retrieval baseline

- **WHEN** the save-time fixture is added or extended
- **THEN** the retrieval corpus, the query set and every committed retrieval baseline SHALL be unchanged

#### Scenario: The sweep exercises the production curation path

- **WHEN** a labelled save is ingested by the sweep
- **THEN** its candidates SHALL be produced by the same detection and pending-row code `memory.save` runs, and not by a copy of it

#### Scenario: Two sweeps on unchanged inputs agree

- **WHEN** the save-time sweep is run twice against an identical fixture and grid
- **THEN** both runs SHALL produce identical output
