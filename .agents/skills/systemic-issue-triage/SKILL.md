---
name: systemic-issue-triage
description: >-
  Triage new Rembric bug reports, GitHub issues, repeated support failures, and
  backlogs by verified causal class rather than one issue at a time. Use whenever
  the user asks to triage issues, investigate recurring reports, reduce a bug
  backlog, decide whether reports are duplicates/stale, or plan a systemic fix.
  Do not use it for a single already-reproduced defect; use `diagnose` instead.
license: Apache-2.0
metadata:
  adapted_from: 'Gentleman Programming / gentle-ai systemic-issue-triage'
---

# Systemic Issue Triage

Treat each issue's stated mechanism as a hypothesis, not evidence. The purpose
is to eliminate a causal class with the smallest safe change, rather than grow
one-off guards, flags, and states around its symptoms.

## Before triaging

1. Read every issue body and relevant comments, not just titles or labels.
2. Fetch `origin/main` and record the commit being evaluated. A report against
   an older release may already be fixed, but it is not proof until the reported
   scenario succeeds on the current target.
3. Read the affected OpenSpec contract in `openspec/specs/`. For a change that
   would alter behaviour, add an MCP tool, or affect a load-bearing invariant,
   open an OpenSpec change before implementation.
4. Build and run the narrowest real reproduction. Pair it with a passing
   control; a green probe that did not reach the boundary proves nothing.

Use `diagnose` for the reproduction loop. If the affected surface is HTTP, MCP,
or migrations, read `rembric-smoke-tests` and probe the actual mounted stack.

## Classification

Place every report in one bucket and record its evidence:

| Bucket            | Meaning                                                | Required evidence                                   |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------- |
| A — in flight     | An approved, unmerged change addresses it              | Change/PR plus the test that will prove the report  |
| B — duplicate     | It has the same verified causal root as another report | Canonical tracker and shared root                   |
| C — new defect    | Current `origin/main` reproduces a new causal root     | Repro command/test and root cluster                 |
| D — request       | Intended new capability, not broken promised behaviour | Relevant spec and decision needed                   |
| E — unclear/stale | Evidence cannot establish a current defect             | Exact question or current-build verification result |

Do not equate a matching symptom with a duplicate. Cluster by the mechanism that
makes it happen. Two or more reports with the same root receive one root fix and
named evidence for every closure.

## Rembric-specific design gates

Before proposing a fix, test it against these constraints:

- **Delete or relax before adding.** A new lifecycle state, MCP verb, config
  flag, compatibility path, cache, or parallel source of truth needs a written
  reason why removing the causal mechanism is impossible.
- **Keep scope at the service boundary.** A UI or MCP symptom must not tempt a
  handler-level scope bypass. Scoped service/repository operations still require
  `resolveEffectiveScope` and a `Scope` parameter.
- **Preserve append-only memory.** Do not repair reports by deleting rows or
  updating memory content. Use lifecycle transitions and replacement links.
- **Make refusals actionable.** Any error, dashboard message, or tool response
  must name a runnable safe continuation when one exists. Execute the named
  command or probe the named route; a plausible-looking exit is not evidence.
- **Do not strand half an issue.** If one thread reports distinct failures,
  state which root is addressed and keep the unresolved part open or split it
  before closing anything.
- **Verify consumer-visible contracts.** When docs, assets, and generated
  plugin files might differ, inspect the copy that each of the five clients
  actually consumes. Search user-facing strings as well as symbol references
  before retiring a command or workflow.

## Root-cluster plan

Create a read-only mechanism map before editing. For each claim, record one
`file:line` anchor, the observed behaviour, and the evidence that distinguishes
it from nearby hypotheses. If code contradicts the issue, the map wins; update
the disposition rather than forcing a patch to fit the report.

For each cluster, propose:

1. **Root and affected reports** — canonical tracker and all linked issue IDs.
2. **Minimal fix shape** — preferably make the invalid state unreachable.
3. **Proof** — failing reproduction first, its passing control, regression test,
   and smoke boundary where applicable.
4. **Contract/migration impact** — OpenSpec change, migration, plugin/client,
   dashboard, and API consequences.
5. **Closure criteria** — exact commit/PR and tests required for each report.

Keep independent clusters separate. If the scope overlaps another active issue
or change, stop and reconcile ownership and error precedence before coding.

## Closing discipline

Close only after independently executing the reported scenario on the current
build. A closure comment must state the disposition, evidence, current commit
or merged PR, and that the reporter may reopen with a current reproduction.

Never close because a test "should cover it", a worker says it is fixed, or a
similar-looking patch landed. Re-run the key test and inspect the diff yourself;
a subagent report is a hypothesis until verified.

## Report format

Return:

1. bucket counts;
2. a table: `issue | bucket | root cluster | current-build evidence | next step`;
3. urgent flags (data integrity, cross-scope access, dead-end workflow,
   migration/client compatibility);
4. one fix batch per root: affected issues, smallest design, named tests, and
   expected deletion/addition footprint; and
5. a borderline list with the concrete evidence still needed.
