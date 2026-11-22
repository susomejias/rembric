## ADDED Requirements

### Requirement: The save-time sweep MUST report candidate band composition

The save-time sweep (`pnpm run eval:save-time`) SHALL report what the confidence bands do to the judgment queue, alongside its existing calibration of the lexical floor. The bands are defined by the `memory` capability, "Save-time candidates MUST be classified into confidence bands by one shared function".

**The fixture.** It SHALL carry a labelled `related` class: saves about the same subject as a named base memory that neither duplicate nor contradict it. The class SHALL live in its own list, apart from the saves the floor is calibrated on.

**The floor section.** It SHALL be produced with the bands disabled through a test seam that is never read from the environment, so that it keeps measuring the floor alone. On unchanged inputs, its output SHALL stay byte-identical to the floor's committed calibration.

**The band section.** It SHALL run the production arm at the shipped lexical floor over the labelled saves followed by the related saves, twice: once with the bands disabled and once enabled. For each class it SHALL report:

- the pending rows written in each run;
- with the bands enabled, the high-band and middle-band pending rows and the low-band related rows;
- for every class with a named target, how many targets landed in each band or were not surfaced.

It SHALL also report:

- the queue depth: the total of pending rows over the saves, for both runs, and per save;
- the pending rows written while ingesting the retrieval corpus, for both runs.

The section SHALL name its instrument. It SHALL NOT be tabulated with any latency series.

**What the sweep demonstrates.** The band constants are calibrated on per-band verdict rates, not on the fixture. The related saves are written to exercise each band rule. The section therefore demonstrates the consequence of the bands on the fixture, and SHALL NOT be presented as a measurement of how often a band occurs in real use.

#### Scenario: The floor calibration is unchanged

- **WHEN** the sweep runs on unchanged inputs after the bands are added
- **THEN** every line of its floor section SHALL match the floor change's committed sweep output byte for byte

#### Scenario: The band section reports both runs

- **WHEN** the sweep runs
- **THEN** its band section SHALL report the queue depth over the saves with the bands disabled and enabled, and the per-class high, middle and related counts with the bands enabled

#### Scenario: Without an embedder the bands change nothing

- **WHEN** the sweep's curation path runs without an embedder, with the bands disabled and then enabled
- **THEN** both runs SHALL write the same pending rows, because every cosine is unknown and every admitted pair is middle-band

#### Scenario: Every labelled related save names an existing base memory

- **WHEN** the fixture is loaded
- **THEN** every save of the `related` class SHALL name a base memory that exists in the fixture
