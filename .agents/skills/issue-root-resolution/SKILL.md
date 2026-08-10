---
name: issue-root-resolution
description: >-
  Resolve a verified cluster of Rembric issues from causal root to evidence-gated
  closure. Use after systemic triage identifies a shared root, or when the user
  asks to attack issues at the root, create a mechanism map, plan a deletion-first
  fix, or close a fixed/stale issue cluster. Use `diagnose` for a single defect
  whose reproduction is not yet established.
license: Apache-2.0
metadata:
  adapted_from: 'Gentleman Programming / gentle-ai issue-root-resolution'
---

# Issue Root Resolution

A cluster is resolved when the mechanism that permits it is removed or guarded
at the correct boundary, each affected report has executable evidence, and the
implementation remains faithful to Rembric's specifications and invariants.
Do not turn a cluster into a collection of symptom patches.

## 1. Establish the current mechanism

Work from current `origin/main`, not an issue's historical description.

1. Read full issue bodies, comments, linked PRs, and relevant OpenSpec specs.
2. Reproduce every candidate root through a real caller boundary; include a
   passing control in the same run.
3. Make a read-only mechanism map before editing. Every claim gets a
   `file:line` anchor and explains what happens today, not what the issue says
   should happen.
4. Record report date and the commit/release being tested. A pre-fix report is
   not evidence that the current build remains broken.

If the map contradicts the report, say so. The symptom may be valid while the
proposed mechanism is wrong; strengthen the repro until it distinguishes them.

## 2. Shape the smallest root fix

Rank alternatives in this order:

1. remove the mechanism, making the whole class impossible;
2. add a static/invariant guard that makes reintroduction fail;
3. apply a local predicate fix behind a failing real-surface reproduction;
4. only when evidence rules out the above, add a new state, flag, command,
   compatibility path, or other lasting surface.

For every option that adds surface, explain why a deletion/relaxation shape
cannot work. Do not add a parallel representation of truth: memory lifecycle,
project scope, and topic convergence already have authoritative locations.

Apply these Rembric constraints while designing:

- Scope is resolved at the service layer. New MCP tools use
  `resolveEffectiveScope`; handlers do not construct scopes or infer a default.
- Append-only data remains append-only: do not `DELETE` memory rows or update
  content to correct a defect. Use existing lifecycle/replacement semantics.
- SQL belongs in `src/db/`, services own transactions, and scoped repository
  methods require `Scope`.
- A behavioural change, new MCP tool, or invariant change needs an OpenSpec
  change before implementation. Table-rebuild migrations rely on the runner's
  FK-safety dance; do not reproduce it ad hoc in a migration.
- Plugin work must preserve one shared implementation across five clients; read
  `rembric-plugin-development` before changing `apps/plugin/`.

Write unresolved maintainer choices as explicit decision items with a recommended
default. An existing decision in an issue, spec, or accepted design outranks a
new plan table.

## 3. Implement with proof, not confidence

Make independently reviewable slices, ordered by root mechanism rather than by
issue number. For each slice:

1. Turn the minimized real scenario into a failing regression test at the right
   seam. Confirm it fails before the fix.
2. Apply the smallest change that addresses the root.
3. Run the test, its control, relevant typecheck/lint, and the original repro.
4. When HTTP, MCP, migrations, or client integration changed, run the relevant
   real-stack smoke from `rembric-smoke-tests`.
5. Inspect every worker/subagent diff and independently re-run its key proof.
   A report of success is not evidence.

A new guard is unproven until weakening each condition makes the test that names
it fail. Use `scripts/mutate.mjs` where it fits; a test green on both sides of
the change does not establish the guard.

## 4. Verify and close precisely

For each issue, select exactly one closure basis:

| Basis           | Required evidence                                                         |
| --------------- | ------------------------------------------------------------------------- |
| Fixed           | Merged commit/PR and a named passing test/repro on current build          |
| Superseded      | Recorded maintainer decision or OpenSpec change that replaces the request |
| Surface retired | Current-build proof that the affected public surface no longer exists     |
| Duplicate       | Canonical issue with its own fixed evidence                               |
| Not closable    | Missing reproduction, unmerged dependency, or a distinct unresolved root  |

Do not close an issue whose fix is merely in an unmerged PR. Do not call an
issue stale only because its original mechanism disappeared: verify the reported
outcome on the current build first. For multi-part reports, document the split
and leave the remaining part open.

Before a public closure comment or final report, run the cited evidence yourself
and name both the test and the boundary it exercises. Include a reopen path for
a current reproduction.

## Report format

Deliver a concise resolution packet:

1. **Roots table:** `root | issues | current state | mechanism-map anchors`.
2. **Plan:** deletion-first fix shape, OpenSpec/decision items, owners, and
   independently revertible slices.
3. **Evidence matrix:** `issue | closure basis | proof run | result`.
4. **Borderline items:** what is still unknown or blocked, and the next exact
   probe.
5. **Verification summary:** commands run, controls, smoke results, and any
   compatibility/migration/client surfaces checked.
