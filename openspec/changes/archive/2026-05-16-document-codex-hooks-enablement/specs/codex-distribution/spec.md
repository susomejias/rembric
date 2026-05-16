## MODIFIED Requirements

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the marketplace plugin install as the primary path, document the credential flow, document the platform-required enablement steps for plugin hooks (which Codex gates behind an under-development feature flag and a per-hook trust review as of `codex-cli 0.130.0`), and retain a manual `config.toml` fallback for users who do not want the plugin.

#### Scenario: Primary install path

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install option SHALL be `codex plugin marketplace add <repo>` followed by `codex plugin install rembric`
- **AND** the section SHALL link to or summarise the env-var credential requirement

#### Scenario: Platform-required hook enablement

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that two additional platform-required steps are necessary to make plugin-bundled hooks fire under `codex-cli 0.130.0`:
  - **Step 1**: enable the `plugin_hooks` feature with `codex features enable plugin_hooks`. The doc SHALL note that this feature is currently `under development` in Codex (default off) and that future Codex releases may default it on — readers should run `codex features list` to confirm before assuming.
  - **Step 2**: open `/hooks` inside Codex and trust each of the 4 plugin-bundled hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`). Codex surfaces a startup banner of the form *"N hooks need review before they can run. Open `/hooks` to review them."* — until each hook is trusted, it loads but does not execute.
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler.

#### Scenario: Symptom-to-cause troubleshooting table

- **WHEN** a reader scrolls the Codex section of `docs/agents.md` looking for a fix to a specific symptom
- **THEN** the doc SHALL include a "If you see X, the cause is Y" table covering the failure modes a Codex user actually observes:
  - `/dashboard/sessions` stays empty after running Codex sessions → `plugin_hooks` feature off OR hooks not yet trusted.
  - `/plugins` panel shows "No plugin hooks" → `plugin_hooks` feature off.
  - Startup banner "N hooks need review" appears repeatedly → hooks need `/hooks` review and per-hook approval.
- **AND** the table SHALL link the symptom rows to the relevant remediation step from the previous scenario.

#### Scenario: Manual fallback preserved

- **WHEN** the same section is read
- **THEN** a "manual config.toml, no plugin" appendix SHALL document the raw `[mcp_servers.rembric]` block using `transport = "streamable-http"` with a slug-hardcoded URL
- **AND** the appendix SHALL note that this path has no Codex hooks and no slug auto-resolution — the marketplace plugin install is the recommended path for those features
