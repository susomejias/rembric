## ADDED Requirements

### Requirement: Install URL freshness is CI-enforced via static-grep invariant

The repository SHALL include a Vitest invariant test (in `apps/server/src/test/invariants.test.ts`) that fails when any tracked file under `git ls-files` contains the literal substring `raw.githubusercontent.com/susomejias/rembric/main/plugin/` or `github.com/susomejias/rembric/blob/main/plugin/`, **outside an explicit file-path allow-list**. The allow-list SHALL be limited to the spec files that intentionally document the legacy 404 contract:

- `openspec/specs/open-source-distribution/spec.md`
- `openspec/specs/hermes-agent-plugin/spec.md`
- `openspec/specs/opencode-plugin/spec.md`

Archived OpenSpec changes (`openspec/changes/archive/**`) SHALL be excluded by path, mirroring the exclusion already used by sibling invariants. The test SHALL NOT issue any network request; the assertion is purely substring presence in the working-tree source.

The failure message SHALL name the offending `<file>:<line>` and point the reader at the allow-list location so the regression is self-diagnosing.

#### Scenario: Drift caught in CI

- **WHEN** a contributor opens a PR that adds the substring `raw.githubusercontent.com/susomejias/rembric/main/plugin/` to a tracked file outside the allow-list (for example, a copy-pasted install command in a new markdown file)
- **THEN** the invariant test SHALL fail with a message naming the file and line of the offending occurrence
- **AND** the contributor SHALL either correct the URL to `…/main/apps/plugin/…` or add a justification by extending the allow-list in the same PR

#### Scenario: Intentional spec documentation is not flagged

- **WHEN** the invariant test runs against the current repository state with the three allow-listed spec files containing legacy `main/plugin/` references (documenting the 404 contract)
- **THEN** the test SHALL pass
- **AND** the allow-list SHALL appear once at the top of the test case, alongside a one-line comment identifying each entry as a 404-contract spec

#### Scenario: Test runs offline

- **WHEN** the invariant test executes in a sandbox without network access (the standard `pnpm test` environment)
- **THEN** the test SHALL complete in well under one second
- **AND** no DNS lookup, HTTP request, or filesystem access outside the repository working tree SHALL be issued
