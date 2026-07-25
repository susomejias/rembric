## MODIFIED Requirements

### Requirement: Regressions MUST fail CI via a committed ratchet

Committed baseline scorecards SHALL define a floor per metric. CI SHALL run the harness and SHALL fail when any metric falls below its floor. The harness SHALL run as a target separate from the unit-test suite, because it is slow, and a floor SHALL only be lowered by an explicit committed change to the baseline.

The ratchet SHALL be enforced by the baseline WRITER, not left to the author's discipline. A floor derived as `measured − tolerance` is not a gate on its own: regenerating baselines after a regression rewrites the floor UNDERNEATH the regressed value, so the next run compares against the worse number and the job stays green permanently, with nothing recording that the gate moved. The writer SHALL therefore never reduce an existing committed floor as a side effect of regenerating baselines — a proposed floor below the committed one is discarded in favour of the committed one, and the fact is reported.

Lowering a floor SHALL remain possible, because a deliberate trade (recall for tokens, say) is legitimate — but only through an explicit opt-in on the write, and every lowered floor SHALL be named in the output so it appears in review rather than only in a diff of generated JSON. The ratchet SHALL be a pure function, unit-tested independently of the slow harness, so the property "a floor only ever moves up" is asserted rather than assumed.

#### Scenario: A tuning change that regresses recall is rejected

- **WHEN** a change lowers Recall@5 below the committed floor
- **THEN** the evaluation job SHALL fail

#### Scenario: A tuning change that improves recall passes and can raise the floor

- **WHEN** a change raises Recall@5 above the committed floor
- **THEN** the job SHALL pass, and the baseline MAY be updated in the same change to ratchet the floor upward

#### Scenario: Regenerating baselines after a regression does not lower the floor

- **GIVEN** a committed floor and a measurement whose derived floor would fall below it
- **WHEN** baselines are regenerated without the explicit lowering opt-in
- **THEN** the committed floor SHALL be preserved and the attempted reduction SHALL be reported

#### Scenario: Lowering a floor is explicit and named

- **WHEN** baselines are regenerated WITH the lowering opt-in and a floor drops
- **THEN** the written floor SHALL be the lower value and the output SHALL name every metric and `k` that was lowered

#### Scenario: Repeated regeneration cannot drift a floor down

- **GIVEN** an unchanged measurement
- **WHEN** baselines are regenerated any number of times
- **THEN** the floor SHALL be identical after every write

#### Scenario: The harness does not slow the unit suite

- **WHEN** the unit test suite runs
- **THEN** the evaluation harness SHALL NOT execute as part of it
