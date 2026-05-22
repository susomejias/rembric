# Quality Gates

Testing works best when several kinds of feedback reinforce each other.

## Four Sources Of Confidence

- **Static checks** catch mistakes before execution.
- **Unit tests** verify isolated logic and edge cases.
- **Integration tests** verify that collaborating parts work together.
- **End-to-end tests** verify a few critical journeys through the full system.

The default bias is:

- rely heavily on static checks and integration tests
- use unit tests where isolation buys clarity
- keep end-to-end tests focused and few

## Static Checks

Static checks prevent classes of defects cheaply:

- syntax and typing problems
- invalid assumptions about values
- unsafe patterns repeated across the codebase
- violations of agreed code standards

Use them as part of the testing strategy, not as a separate concern.

## Automated Runtime Tests

Automated tests should provide fast, repeatable evidence:

- unit tests keep logic honest
- integration tests validate behavior across boundaries
- end-to-end tests protect the most critical workflows

Use each level for the risk it can prove best, not because every feature needs every level.

## Delivery Gates

A healthy delivery flow usually combines:

- local fast feedback
- repeatable automated checks
- required checks before merge or release
- manual verification only where automation is weak or expensive

If a gate is slow but low-signal, simplify it. If a gate is high-risk but absent, add it.

## Practical Split

- static checks for cheap prevention
- integration tests for the main confidence layer
- unit tests for concentrated logic
- end-to-end tests for a few irreversible or business-critical journeys

This keeps confidence high without overloading maintenance cost.
