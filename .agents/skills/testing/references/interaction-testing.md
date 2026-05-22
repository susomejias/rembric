# Interaction Testing

Interaction testing focuses on what a user, caller, or connected system can observe from the outside.

## Main Principle

Tests should care about behavior at the boundary, not about the internal mechanism used to produce it.

That usually means:

- drive the system through a real entry point
- interact through visible or public surfaces
- assert on outputs, state changes, or externally observable effects
- clean up after each scenario so tests stay isolated

## What To Observe

Prefer outcomes that matter outside the implementation:

- returned values
- visible messages or rendered output
- state transitions
- emitted events
- persisted changes
- calls made to real external boundaries only when those calls are part of the contract

Avoid anchoring tests to:

- internal method calls
- private state shape
- incidental ordering with no business value
- framework-specific details that do not affect behavior

## Query And Check Strategy

When a behavior is user-facing, prefer checks that mirror how the behavior is discovered in real use:

- meaningful labels
- visible names
- accessible roles or semantics
- domain-relevant output

When a behavior is system-facing, prefer checks on the published contract:

- input and output pairs
- command results
- API responses
- stored records

## Render And Cleanup Pattern

Keep test harnesses small:

- create only the state or container you need
- perform the interaction through the normal surface
- return only helpers that improve clarity
- always clean up shared state, files, processes, or DOM

If one test pollutes another, fix isolation before expanding coverage.

## Practical Takeaway

Good interaction tests read like short usage narratives. If a test must know too much about internals to work, the test is likely proving the wrong thing.
