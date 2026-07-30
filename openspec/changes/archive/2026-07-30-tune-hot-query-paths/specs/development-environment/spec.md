## MODIFIED Requirements

### Requirement: The repo MUST provide a non-destructive volumetric seeding harness

The repo SHALL ship a harness at `apps/server/src/scripts/`, exposed as a pnpm script, that builds a corpus of a caller-specified size for performance measurement. It is a separate script from `seed-dev.ts`, whose job is a small hand-authored demo fixture, and neither SHALL be expressed in terms of the other.

**It SHALL NOT be capable of deleting data.** The harness SHALL take an explicit database path, SHALL exit non-zero without writing when that database already contains memories, and SHALL NOT accept a `--reset`, a `--force`, or any environment-gated destructive path. It SHALL refuse to operate on the dev stack's data directory.

This is normative rather than advisory because the failure it prevents has already occurred: the resident dev corpus was destroyed by a tool that wipes on start, and the two files permitted to issue `DELETE FROM memory` are enumerated in an invariant test that this harness SHALL NOT be added to. A tool that cannot delete cannot be the cause.

The harness SHALL scale **memory count, session count, relation count and prompt count independently**, because each grows on its own driver — sessions and prompts with agent activity, relations with how much judging an agent does, memories with the corpus itself — and a finding about one cannot be reproduced on a corpus that derived it from another. An axis whose rows are meaningless alone SHALL refuse rather than silently produce nothing: a relation joins two memories, so requesting relations without enough memories SHALL be a usage error naming the minimum.

The four axes SHALL cover every table a recorded performance claim is measured against. This is normative because the alternative was reached and rejected in practice: the first four tasks of `tune-hot-query-paths` that touched `memory_relations` and `prompts` could not be measured at all, because the harness had no axis for either, and quoting figures from a throwaway corpus would have breached the `data-access` reproducibility requirement on its first real test.

The harness SHALL be **deterministic**: the same seed and sizes SHALL produce the same corpus, so that a comparison between two runs is a comparison of one variable. Determinism SHALL be asserted over the generated content of **every** axis, not merely the largest — an axis absent from the determinism check is an axis whose reproducibility is unverified.

Rows SHALL be written through the application's own write path, so that trigger-maintained and recipe-rebuilt derived state — the FTS indexes (both `memory_fts` and `prompts_fts`), the `replaces` edge table, and the entity tables — is produced the way the running server produces it. The harness SHALL NOT insert directly into a derived table.

The harness SHALL **declare the distribution it produces** — body length, entities per memory, confirmations per memory, scope spread, the superseded fraction, the relation status mix, the prompt body length and the soft-deleted prompt fraction — and that declaration SHALL be asserted by a test against a generated corpus, so a figure citing the shape can be checked rather than trusted. Each declared figure SHALL be labelled with its provenance: reproduced from a prior measurement, or chosen by the harness. A reader SHALL be able to tell a reproduction from a decision without leaving the declaration.

**No axis SHALL perturb another's declared shape.** In particular the harness SHALL NOT judge a generated relation as `supersedes`: that verdict flips the target memory to `superseded` and appends to the source's `replaces`, which would make the memory axis's declared superseded fraction a function of the relation count. The supersede path is exercised through `topic_key` chains on the memory axis instead.

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
- **AND** the comparison SHALL cover every axis the invocation built, so adding an axis without adding it to the determinism check SHALL be caught

#### Scenario: Only the session axis is needed

- **WHEN** a measurement concerns a session-scoped query
- **THEN** the harness SHALL be able to build a large session corpus without also building a large memory corpus
- **AND** the converse SHALL hold, so neither axis forces the cost of the other

#### Scenario: Only the relation or prompt axis is needed

- **WHEN** a measurement concerns a relation-scoped or prompt-scoped query
- **THEN** the harness SHALL be able to build a large corpus on that axis without also paying for a large corpus on the others
- **AND** where one axis genuinely requires another — a relation joins two memories — the requirement SHALL be enforced as a usage error naming the minimum, rather than met by silently generating nothing

#### Scenario: A measurement needs a table the harness cannot populate

- **WHEN** a change must record a performance figure for a query over a table no harness axis builds
- **THEN** the harness SHALL be extended with that axis before the figure is recorded
- **AND** the figure SHALL NOT be taken on a throwaway corpus and quoted, because the `data-access` reproducibility requirement would then be unmet at the moment the claim is published

#### Scenario: The generated corpus does not match the declared shape

- **WHEN** the generator's output diverges from the distribution it documents — entities per memory, body length, confirmations per memory, scope spread, superseded fraction, relation status mix, prompt body length or soft-deleted prompt fraction
- **THEN** the test asserting the declared shape SHALL fail
- **AND** the fix SHALL be to correct whichever of the two is wrong, never to relax the assertion

#### Scenario: A new axis would change an existing axis's shape

- **WHEN** an axis is added or extended in a way that mutates rows another axis's declared shape is asserted over
- **THEN** the generator SHALL avoid the mutation rather than re-derive the other axis's declared figure from it
- **AND** a test SHALL assert the untouched axis's figure on a corpus that also built the new one, so the independence is observed rather than assumed

#### Scenario: A caller draws a retrieval conclusion from a generated corpus

- **WHEN** a change cites a corpus built by this harness as evidence about recall, ranking, fusion or abstention
- **THEN** the claim SHALL be rejected
- **AND** the harness output SHALL have stated that its vectors are synthetic, so the limitation is visible at the point the corpus is produced rather than only in a design document
