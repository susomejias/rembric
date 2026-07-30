## ADDED Requirements

### Requirement: A recorded performance claim MUST be reproducible by a committed harness

A figure asserted about this repo's query performance — a wall-clock timing, a plan shape, a file size, a per-save cost — SHALL be reproducible by a reader who has only the repository. The corpus it was measured on SHALL be describable as a command against a harness committed to the tree, at a stated size and shape, rather than quoted from a database that existed on one machine on one day.

This is scoped to a claim RECORDED in a published spec, a change's `proposal.md` / `design.md` / `measurements.md`, or a code comment that a future decision would rest on. An ad-hoc timing taken while debugging is not governed by this.

The requirement exists because the alternative was measured and found wanting. A full audit of thirteen repositories was performed at 1k / 20k / 50k rows and its conclusions were published; the generator that built those corpora was scratch code and did not survive the session, so every one of those figures became unfalsifiable by anyone but its author. Two later changes had to record dev-corpus figures as "not re-derivable" for the same reason.

A claim's record SHALL therefore carry the harness invocation that rebuilds its corpus — size, shape and seed — beside the figure. A figure whose corpus cannot be rebuilt SHALL be marked as not re-derivable where it appears, rather than presented as though a reader could check it.

The harness SHALL be deterministic under a stated seed, so that a before-and-after comparison is a comparison of the same corpus rather than of two samples.

#### Scenario: A performance figure is recorded with no way to rebuild its corpus

- **WHEN** a change records a timing, a plan shape or a size measured at a corpus scale the repository cannot reproduce
- **THEN** the change SHALL be rejected, or the figure SHALL be marked in place as not re-derivable with the reason
- **AND** a figure marked that way SHALL NOT be used as the sole evidence for a decision the change is asking a reviewer to accept

#### Scenario: A claim cites a corpus the harness can rebuild

- **WHEN** a change records `EXPLAIN QUERY PLAN` output or a wall-clock figure at a stated corpus size
- **THEN** the record SHALL name the harness invocation — the sizes on each axis and the seed — that produces that corpus
- **AND** running that invocation SHALL produce a corpus of the stated shape, so the plan can be re-captured

#### Scenario: Two measurements are compared before and after a change

- **WHEN** a change reports that a query improved from one figure to another
- **THEN** both figures SHALL have been taken against corpora built from the same harness invocation and the same seed
- **AND** a comparison across two independently generated corpora SHALL NOT be reported as a before-and-after, because the difference may be the corpus

#### Scenario: The harness cannot represent what a claim needs

- **WHEN** a claim concerns behaviour the harness deliberately does not model — retrieval quality, ranking, or anything that depends on what the embedding vectors mean
- **THEN** the claim SHALL NOT cite a corpus built by the harness
- **AND** the record SHALL name the instrument that can answer it instead
