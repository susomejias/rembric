## Context

The `restructure-monorepo-apps-layout` change (archived 2026-05-20) moved `plugin/` → `apps/plugin/` and updated most install-command surfaces in lock-step. Four surfaces were missed:

- `apps/plugin/README.md` (Hermes + opencode rows of the install table)
- `apps/plugin/.hermes-plugin/README.md` (3 occurrences)
- `apps/plugin/.opencode-plugin/README.md` (primary install command)
- `apps/plugin/.hermes-plugin/__init__.py` (module docstring install hint)

The `hermes-agent-plugin` spec already requires these per-client READMEs to carry the correct `apps/plugin/` URL. The miss was an execution error, not a spec gap. The root cause is straightforward: `grep` over the diff during the original restructure missed the per-client README/docstring copies because they were duplicated install commands and the diff was already large.

A repeat of this kind of drift is the real risk. The plugin tree will move again at some point (e.g., further monorepo work), and without a guard the same drift will recur.

## Goals / Non-Goals

**Goals:**

- Bring the four broken surfaces back into line with the existing spec (`apps/plugin/...` URLs that return HTTP 200).
- Add a single Vitest invariant case that fails CI if `main/plugin/` (without `apps/`) ever resurfaces in tracked files outside an explicit allow-list of spec files documenting the legacy 404 contract.
- Make the allow-list path-shaped and short, so future restructures cannot quietly grow it.

**Non-Goals:**

- Refactoring the four broken surfaces beyond the URL substring swap (no rewrites, no display-text cleanup of unrelated markdown links).
- Touching the four `openspec/specs/{open-source-distribution,hermes-agent-plugin,opencode-plugin}/spec.md` requirements that intentionally document the legacy URL — those are the spec, not regressions.
- Adding any link-checker tool, broken-URL crawler, or HTTP-probing CI step. The invariant is purely a static-grep check at the source level: cheap, deterministic, no network.

## Decisions

### Decision 1: Static grep over network probe

**Chosen:** Read every tracked file via `git ls-files` and assert the literal substring `main/plugin/` (and the `github.com/.../blob/main/plugin/` equivalent) is absent outside the allow-list. The check runs in the existing `apps/server/src/test/invariants.test.ts`.

**Alternative considered:** A CI step that `curl -sI`s each install URL extracted from documentation and asserts HTTP 200.

**Rationale:** Static grep is:

1. Deterministic — no flakes from `raw.githubusercontent.com` rate limits or transient 5xx.
2. Self-contained — runs in the same Vitest invocation as the rest of the invariants, no new CI job or HTTP fixture.
3. Cheap — sub-second on the full repo.
4. Sufficient — the failure mode we are guarding against is a stale literal in the source tree. If the URL is right in source, it will be right after publish.

The HTTP probe was rejected because it adds a network dependency to the test suite (against the project's "no network in unit tests" implicit contract) and because the 404 we are guarding against is provable from the source alone — no need to ask GitHub.

### Decision 2: Allow-list by file path, not by substring exemption comment

**Chosen:** The invariant maintains a hard-coded list of four spec paths where the legacy URL is intentional:

```
openspec/specs/open-source-distribution/spec.md
openspec/specs/hermes-agent-plugin/spec.md
openspec/specs/opencode-plugin/spec.md
```

(`openspec/changes/archive/**` is excluded by the same path filter the other invariants already use.)

**Alternative considered:** Inline `<!-- legacy-url-ok -->` HTML comments adjacent to each documented 404 reference, with the test scanning for the comment to exempt a substring match.

**Rationale:** File-path allow-list is:

1. Centralised — one place to audit; the spec files are the canonical 404 documentation surfaces.
2. Resistant to copy-paste regressions — a contributor copying a spec snippet into a different file would still trip the invariant.
3. Survives spec rewrites that remove a specific paragraph but keep the requirement nearby.

The comment-marker approach was rejected because it pushes the exemption mechanism into the source files (more places to forget) and tempts contributors to apply the marker to non-spec surfaces "just to make the test pass."

### Decision 3: No new per-plugin component release

**Chosen:** Ship as docs/test-only commits. release-please will not bump any plugin component version. The next routine bump of `hermes-plugin` / `opencode-plugin` will absorb these changes silently.

**Alternative considered:** Cut a patch release for each affected plugin component (`hermes-plugin-v0.9.1`, `opencode-plugin-v0.9.1`) so the corrected URL has a versioned anchor.

**Rationale:** The runtime behaviour of every plugin is unchanged. The `__init__.py` docstring is never read at import-time by Hermes (it is only relevant to humans reading the source). The READMEs are documentation. A version bump implies a code change to consumers; here, consumers see no change at install time except that the URLs they read now resolve.

## Risks / Trade-offs

- **[Risk]** The invariant test's allow-list goes stale: a new spec file is added that legitimately documents the legacy 404 contract but is not in the allow-list, breaking CI. → **Mitigation:** The allow-list is at the top of the test case with a one-line comment explaining what each entry is. Adding a new spec file that documents the 404 is rare (every existing one was added in the same change); when it does happen, the failing CI message will name the file and point at the allow-list location.
- **[Risk]** A contributor working in an unrelated change introduces a `main/plugin/` reference (e.g., in a new doc file describing repo history) and CI fails unexpectedly. → **Mitigation:** Failure message says "Install URL drift detected at <file>:<line>. If this is intentional historical documentation, add the file path to the allow-list at apps/server/src/test/invariants.test.ts:<N>." Cost of a one-line allow-list addition is trivial.
- **[Trade-off]** The invariant does not probe whether `apps/plugin/...` URLs resolve. → **Accepted because** the next directory move will fail the spec's existing "URL SHALL begin with `apps/plugin/`" requirement when the spec itself is updated, and the new `main/<future-path>/` URLs will be guaranteed to exist in the repository (otherwise the move itself didn't ship). A repository-aware path-existence check would add complexity for no real coverage gain.

## Migration Plan

None. The fix is a string replacement in four files plus a new test case. Rollback is `git revert`.
