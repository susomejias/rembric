## ADDED Requirements

### Requirement: CI MUST enforce the coverage gate and keep developer-facing scripts, docs, and thresholds honest

CI SHALL run the server test suite WITH coverage so the thresholds configured in `apps/server/vitest.config.ts` actually gate every pull request. Those thresholds SHALL be set at or below the current real coverage (an enforced floor, never an aspirational number that reds the build), and the ratchet direction SHALL be up-only. `CONTRIBUTING.md` SHALL state the SAME threshold numbers that the config enforces and SHALL NOT claim a coverage behavior CI does not perform. Any developer command documented in `README.md` or `CONTRIBUTING.md` as runnable from the repository root SHALL resolve from the root, and any file path referenced in those docs (e.g. the invariants tests) SHALL point at a path that exists. Runtime plugin code shipped to users (`apps/plugin/bin/**`) SHALL be covered by ESLint. The installer test suite SHALL execute at most once per CI run.

#### Scenario: A PR that drops coverage below the floor fails CI

- **GIVEN** the coverage thresholds are enforced at the configured floor
- **WHEN** a PR reduces coverage below that floor
- **THEN** the CI Test step SHALL fail on the coverage gate

#### Scenario: Documented thresholds equal enforced thresholds

- **WHEN** a contributor compares the coverage numbers in `CONTRIBUTING.md` against `apps/server/vitest.config.ts`
- **THEN** the two SHALL be identical, and CI SHALL run the coverage command that enforces them

#### Scenario: Root-level documented commands resolve

- **WHEN** a fresh clone runs a command the docs present as a repo-root command (e.g. `pnpm run dev`, `pnpm run test:coverage`)
- **THEN** the command SHALL resolve (via a root script or an equally-documented `cd apps/server`) rather than failing with "No script found"

#### Scenario: The shipped bridges are linted

- **WHEN** `pnpm run lint` runs
- **THEN** `apps/plugin/bin/rembric-bridge.mjs` and `apps/plugin/bin/rembric-dotenv.mjs` SHALL be included in the lint set

#### Scenario: The installer suite runs once

- **WHEN** the CI workflow for a PR completes
- **THEN** `install.test.ts` SHALL have been executed exactly once, and the shell-syntax (`sh -n`) checks SHALL still run
