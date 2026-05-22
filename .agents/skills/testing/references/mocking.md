# Mocking

This section covers the core role of stubs, spies, mocks, and test doubles.

## When Mocking Helps

Mocking is most useful at unstable or expensive boundaries:

- network requests
- time
- randomness
- payments
- third-party APIs
- slow or flaky collaborators

If the thing you are mocking is just your own internal helper, stop and reconsider the design first.

## Core Terms

- **Stub**: returns predefined data or behavior.
- **Spy**: records how a function was called.
- **Mock**: a programmable double with behavior and call assertions.
- **Test double**: umbrella term for stub, spy, and mock.
- **Monkey patching**: replacing object properties or functions during a test.

## Key Takeaways

- Random or side-effect-heavy code is a good candidate for a test double.
- Use the smallest double that solves the problem.
- Restore original behavior after the test.
- Keep the seam obvious so the test stays readable.

## Good Uses

- force a deterministic winner in a random game
- stop real HTTP calls
- simulate failures from an external dependency
- speed up slow or expensive code paths

## Bad Uses

- verifying every internal function call
- mocking the exact implementation you are supposed to be refactoring safely
- replacing so much of the system that the test no longer proves useful behavior

Mocking should reduce flakiness and cost, not reduce realism so far that confidence disappears.
