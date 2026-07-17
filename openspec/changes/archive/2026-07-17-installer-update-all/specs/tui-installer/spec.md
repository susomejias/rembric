## ADDED Requirements

### Requirement: `--action=update` without `--agent` updates every installed plugin that needs it

When the installer runs non-interactively with `--action=update` and either no `--agent` is given or `--agent=all` is given explicitly, it SHALL update every client plugin whose detected state (per the same `installed_version`/`available_version`/`vercmp` logic `--status` uses) is `update`, and SHALL skip every other client without erroring: `none` (already up to date), `install` (not installed), `ahead`, or `unknown`. The command SHALL exit `0` even when no plugin needs updating. This is the command `memory.about` advertises as `update_all` — it MUST succeed with no other flags.

`--agent=<specific-clients>,…` (naming one or more of `claude,codex,hermes,opencode` explicitly) SHALL remain unaffected by this requirement: it updates exactly the named clients regardless of their detected state, as before.

In the interactive menu, the Plugins section's agent-selection prompt SHALL include a first entry — `all — update outdated` — that triggers the same update-all behavior, presented directly below the already-rendered per-agent status table so the operator sees which agents will be touched before selecting it.

#### Scenario: Bare `--action=update` updates only the outdated agents

- **GIVEN** opencode is installed at a version older than the published one, and claude/codex/hermes are not installed
- **WHEN** the installer runs `--action=update` with no `--agent`
- **THEN** it SHALL update opencode
- **AND** it SHALL report claude, codex, and hermes as skipped (not installed) without error
- **AND** the process SHALL exit `0`

#### Scenario: Nothing needs updating

- **GIVEN** every installed plugin is already at the published version, and any others are not installed
- **WHEN** the installer runs `--action=update` with no `--agent`
- **THEN** it SHALL update nothing, report each agent's skip reason, and exit `0` — NOT an error

#### Scenario: `--agent=all` is an explicit alias for the same behavior

- **WHEN** the installer runs `--agent=all --action=update`
- **THEN** it SHALL behave identically to `--action=update` with no `--agent` at all

#### Scenario: An explicit agent list is unaffected

- **WHEN** the installer runs `--agent=claude,codex --action=update`
- **THEN** it SHALL update exactly claude and codex, regardless of their detected `vercmp` state, exactly as before this change

#### Scenario: The interactive menu offers update-all

- **GIVEN** the operator has navigated to the Plugins section
- **WHEN** the "Which agent?" prompt is shown
- **THEN** its first entry SHALL be `all — update outdated`, appearing below the rendered status table
- **AND** selecting it SHALL run the same update-all behavior as the headless `--action=update` command
