# Fundamentals

This section covers the core mental model behind assertions, runners, and useful failures.

## What A Test Is

At the most basic level, an automated test is code that throws an error when reality differs from expectation.

That means the core job of a testing tool is not magic. It is to help you:

- express expectations clearly
- run many tests together
- isolate failures
- produce useful error messages fast

## Assertion Library vs Testing Framework

Keep these ideas separate:

- An **assertion library** helps you say what should be true.
  It provides a readable way to compare actual behavior with an expected result.
- A **testing framework** finds tests, runs them, isolates them, and reports results.

Useful framework features include:

- grouping related tests
- setup and cleanup hooks
- showing all failures instead of stopping too early
- pointing clearly to which scenario failed

## Why Learn The Internals

Understanding the moving parts makes you better at using the tools:

- you write simpler tests
- you debug framework behavior faster
- you choose the right abstraction level
- you avoid cargo-cult configuration

If a test setup feels mysterious, reduce it until you can explain:

1. how the code is executed
2. where assertions fail
3. how the runner reports it
4. what cleanup or isolation is needed

## Practical Takeaway

Good tests are not "more advanced" because they use more APIs. They are better because they make failures obvious, isolate scenarios well, and state intent in plain language.
