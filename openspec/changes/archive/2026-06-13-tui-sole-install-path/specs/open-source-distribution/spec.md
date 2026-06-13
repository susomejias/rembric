## MODIFIED Requirements

### Requirement: The README MUST accurately describe the current distribution model

`README.md` SHALL describe Rembric's current distribution and install path without referencing distribution mechanisms that have been removed. References to "npm package", "operator CLI", or any other deprecated install mechanism SHALL NOT appear in the README. The README SHALL link to `docs/backup.md` from a prominent install-or-quickstart-adjacent section. The README SHALL link to `SECURITY.md` from the same nav header as `Contributing`.

The README's primary, lead install/upgrade instruction SHALL be the **TUI installer** (the repo-root `install.sh` shim, canonical URL `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`). The manual Docker quickstart (`curl docker-compose.yml` + `.env.example` + `docker compose up -d`) and the per-client commands SHALL remain in the README only under an explicitly-labelled "Manual / advanced" section, never as the primary path.

When the README does show per-client install URLs (in the manual section), they SHALL point at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.<client>-plugin/install.sh` for the curl-pipe-sh clients (Hermes, opencode), and at `https://github.com/susomejias/rembric` for the marketplace-driven clients (Claude Code, Codex CLI — both consumed via `<client> plugin marketplace add <repo-url>`). The legacy `plugin/.<client>-plugin/install.sh` URLs SHALL NOT appear in the README; any per-client URL shown SHALL be the canonical `apps/plugin/...` form.

#### Scenario: README leads with the TUI installer

- **WHEN** a third party reads the README's install/quickstart section top-to-bottom
- **THEN** the first install/upgrade command presented SHALL be the TUI installer (`.../main/install.sh`)
- **AND** the manual Docker quickstart and per-client commands SHALL appear only below, under a heading that marks them as manual / advanced

#### Scenario: README stale-claim regression

- **WHEN** a PR re-introduces phrases like "One npm package", "operator CLI", or anchors to removed sections like `#cli-operations`
- **THEN** a CI check or invariant test SHALL flag the regression, OR the reviewer SHALL block the PR with a reference to this requirement

#### Scenario: README structural elements

- **WHEN** a third party loads the README on GitHub
- **THEN** the page SHALL contain (in order): logo / banner, tagline mentioning Docker as the canonical distribution, anchor nav including links to architecture / quickstart / contributing / SECURITY, a clear "Data and your responsibility" section once `add-data-protection-defaults` lands, and a footer linking to LICENSE and CODE_OF_CONDUCT

#### Scenario: README plugin install URLs point at apps/plugin

- **WHEN** a third party copies a per-client install command (Hermes or opencode) from the README's manual section
- **THEN** the URL SHALL begin with `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/`
- **AND** the URL SHALL NOT begin with `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/` (legacy form, now returns HTTP 404)
