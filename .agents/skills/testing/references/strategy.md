# Testing Strategy

This is the decision guide for what to test, how much to test, and where to spend effort.

## The Testing Trophy Bias

Use this default bias:

- Static analysis catches mistakes earliest and cheapest.
- Integration tests are the best balance of confidence and speed.
- Unit tests are useful for isolated logic, but not as the main testing diet.
- End-to-end tests are valuable for a few critical user journeys, not for everything.

Keep the bias simple:

- Write tests.
- Not too many.
- Mostly integration.

## What To Test First

Use this prioritization checklist:

1. Ask what would be the worst part of the application to break.
2. List the untested code related to that functionality.
3. Map both developer interactions and user interactions around it.
4. Turn one interaction into a manual checklist.
5. Automate one step at a time.
6. Repeat from the highest-risk path outward.

This keeps test work tied to business risk rather than abstract coverage goals.

## Prioritization Heuristics

Start with:

- money movement, checkout, auth, permissions
- destructive actions and state transitions
- validation and error handling
- data mapping and business rules
- flows users repeat often

Delay or minimize:

- thin wiring with little branching
- implementation-only helpers that already get covered indirectly
- visual details with low product risk
- exhaustive end-to-end duplication of already-covered workflows

## Guardrails

- Do not optimize for 100% code coverage.
- Do not TDD everything by default.
- Do not mock everything just because you can.
- Do not add tests whose main value is proving framework internals.

If coverage rises but confidence does not, the strategy is off.
