## MODIFIED Requirements

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the **TUI installer** (`apps/plugin/install.sh` / the root shim) as the primary install path. It SHALL retain the Codex marketplace plugin install (`codex plugin marketplace add … && codex plugin install rembric`) and the manual `config.toml` fallback, but both SHALL appear under an explicitly-labelled "Manual / advanced" subsection, not as the lead instruction. The section SHALL document the credential flow, and the platform-required enablement steps for plugin hooks (which Codex gates behind an under-development feature flag and a per-hook trust review as of `codex-cli 0.130.0`). The "trust each of the N plugin-bundled hooks" guidance SHALL enumerate the FIVE hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`).

#### Scenario: Codex section leads with the TUI installer

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `codex plugin marketplace add` / `codex plugin install` commands and the manual `config.toml` SHALL appear only under a manual / advanced heading

#### Scenario: Platform-required hook enablement enumerates five hooks

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that two additional platform-required steps are necessary to make plugin-bundled hooks fire under `codex-cli 0.130.0`:
  - **Step 1**: enable the `plugin_hooks` feature with `codex features enable plugin_hooks`. The doc SHALL note that this feature is currently `under development` in Codex (default off) and that future Codex releases may default it on — readers should run `codex features list` to confirm before assuming.
  - **Step 2**: open `/hooks` inside Codex and trust each of the 5 plugin-bundled hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`). Codex surfaces a startup banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ — until each hook is trusted, it loads but does not execute.
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler.
