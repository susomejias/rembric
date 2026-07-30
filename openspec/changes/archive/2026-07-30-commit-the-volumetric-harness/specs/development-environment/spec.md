## ADDED Requirements

### Requirement: The repo MUST provide a non-destructive volumetric seeding harness

The repo SHALL ship a harness at `apps/server/src/scripts/`, exposed as a pnpm script, that builds a corpus of a caller-specified size for performance measurement. It is a separate script from `seed-dev.ts`, whose job is a small hand-authored demo fixture, and neither SHALL be expressed in terms of the other.

**It SHALL NOT be capable of deleting data.** The harness SHALL take an explicit database path, SHALL exit non-zero without writing when that database already contains memories, and SHALL NOT accept a `--reset`, a `--force`, or any environment-gated destructive path. It SHALL refuse to operate on the dev stack's data directory.

This is normative rather than advisory because the failure it prevents has already occurred: the resident dev corpus was destroyed by a tool that wipes on start, and the two files permitted to issue `DELETE FROM memory` are enumerated in an invariant test that this harness SHALL NOT be added to. A tool that cannot delete cannot be the cause.

The harness SHALL scale **memory count and session count independently**, because sessions grow with agent activity rather than with corpus size and a finding about one cannot be reproduced on a corpus that derived it from the other.

The harness SHALL be **deterministic**: the same seed and sizes SHALL produce the same corpus, so that a comparison between two runs is a comparison of one variable.

Rows SHALL be written through the application's own write path, so that trigger-maintained and recipe-rebuilt derived state — the FTS indexes, the `replaces` edge table, and the entity tables — is produced the way the running server produces it. The harness SHALL NOT insert directly into a derived table.

The harness SHALL **declare the distribution it produces** — body length, entities per memory, confirmations per memory, scope spread, and the superseded fraction — and that declaration SHALL be asserted by a test against a generated corpus, so a figure citing the shape can be checked rather than trusted.

Where the harness is deliberately unrepresentative it SHALL say so in its own output. In particular its embedding vectors are synthetic, so no claim about retrieval quality, ranking or abstention may be drawn from a corpus it built.

#### Scenario: The harness is pointed at a database that already holds memories

- **WHEN** the harness is invoked against a database whose `memory` table is non-empty
- **THEN** it SHALL exit with a non-zero code and write nothing
- **AND** the message SHALL name the path and say that the harness never deletes, so the caller removes the file deliberately rather than looking for a flag

#### Scenario: A contributor adds a reset path to the harness

- **WHEN** a change adds a `--reset`, a `--force`, or an environment-gated wipe to the harness, or adds the harness to the `DELETE FROM memory` allow-list
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be recorded as the destroyed-corpus incident rather than as style, so the constraint is not read as arbitrary

#### Scenario: The same invocation is run twice

- **WHEN** the harness is run twice with the same seed and the same sizes into two empty databases
- **THEN** the two corpora SHALL be equivalent: the same row count, the same distribution, and the same generated content per row
- **AND** a plan captured against one SHALL be reproducible against the other

#### Scenario: Only the session axis is needed

- **WHEN** a measurement concerns a session-scoped query
- **THEN** the harness SHALL be able to build a large session corpus without also building a large memory corpus
- **AND** the converse SHALL hold, so neither axis forces the cost of the other

#### Scenario: The generated corpus does not match the declared shape

- **WHEN** the generator's output diverges from the distribution it documents — entities per memory, body length, confirmations per memory, scope spread, or superseded fraction
- **THEN** the test asserting the declared shape SHALL fail
- **AND** the fix SHALL be to correct whichever of the two is wrong, never to relax the assertion

#### Scenario: A caller draws a retrieval conclusion from a generated corpus

- **WHEN** a change cites a corpus built by this harness as evidence about recall, ranking, fusion or abstention
- **THEN** the claim SHALL be rejected
- **AND** the harness output SHALL have stated that its vectors are synthetic, so the limitation is visible at the point the corpus is produced rather than only in a design document
