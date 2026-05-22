---
name: testing
description: Pragmatic testing guidance focused on confidence, behavior over implementation details, and integration-first coverage. Use when designing a test strategy, writing or reviewing tests, reducing brittle mocks, or deciding what is worth testing in an application or library.
---

# Testing

Design tests that increase confidence, survive refactors, and reflect real usage.

## Reference Map

- Read [references/strategy.md](references/strategy.md) when deciding what to test, how much to test, or how to prioritize coverage.
- Read [references/fundamentals.md](references/fundamentals.md) when you need the core mental model for assertions, frameworks, isolation, and useful failures.
- Read [references/interaction-testing.md](references/interaction-testing.md) when testing user-visible behavior, flows, or observable system interactions.
- Read [references/quality-gates.md](references/quality-gates.md) when deciding how static checks, automated tests, manual checks, and delivery gates should work together.
- Read [references/mocking.md](references/mocking.md) when dealing with stubs, spies, mocks, randomness, or flaky external boundaries.
- Read [references/glossary.md](references/glossary.md) when the user asks about testing terminology.

## Defaults

- Test behavior through public interfaces.
- Follow a testing trophy bias: lean on static checks and integration tests, with fewer unit and end-to-end tests.
- Prefer a few high-value integration tests over many shallow micro-tests.
- Mock only real boundaries: network, time, randomness, payments, third-party APIs.
- Choose assertions a user, caller, or downstream system would care about.
- Keep tests deterministic, small, and readable.

## Workflow

1. Identify the highest-risk behavior or workflow.
2. Pick the cheapest test level that can prove it: static, unit, integration, or end-to-end.
3. Arrange realistic inputs, state, and environment.
4. Act through the public API, visible surface, or command boundary.
5. Assert observable outcomes, not internal steps.
6. Keep failures specific and setup cleanup reliable.
7. Remove setup, mocks, and assertions that do not increase confidence.

## Test Level Guide

- **Unit**: pure logic, parsing, formatting, branching, edge cases.
- **Integration**: component or service workflows, validation, state changes, error handling.
- **End-to-end**: a few critical user journeys or irreversible flows.

Default to integration tests when unsure.

## Red Flags

- Tests fail after a refactor even though behavior did not change.
- Coverage is rising, but confidence is not.
- Most value comes from mocking internals.
- Assertions focus on function calls instead of outcomes.
- Snapshots are large, blind, or treated as primary verification.
- The suite is slow mainly because tests duplicate setup with low signal.

## Guidance

- Test the path users actually take, not the implementation you happen to have today.
- Prefer one clear reason for a test to fail.
- Cover happy path, one meaningful edge case, and one important failure mode before expanding.
- If a test is hard to write, consider whether the production API or design is the real problem.
- When unsure what to automate first, start with the prioritization checklist in `references/strategy.md`.
