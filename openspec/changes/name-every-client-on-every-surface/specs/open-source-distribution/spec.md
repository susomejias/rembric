## MODIFIED Requirements

### Requirement: The repository MUST provide structured issue and pull request templates

`.github/ISSUE_TEMPLATE/` SHALL contain at minimum a `bug.md` (or `bug.yml`) and `feature.md` (or `feature.yml`) template, plus a `config.yml` that disables blank issues and routes "I have a question" to GitHub Discussions if Discussions are enabled. `.github/PULL_REQUEST_TEMPLATE.md` SHALL exist with a checklist mirroring `CONTRIBUTING.md::Pull request checklist`.

The bug template's `Client` field SHALL offer a distinct option for **every** bundled plugin client, alongside its non-client options (`Other MCP client`, `Dashboard only`, `Server-side / no client involved`, `N/A`). This requirement SHALL NOT enumerate the bundled clients or state how many there are: membership is owned by the `development-environment` capability's `apps/plugin/` description, and a list frozen here is a list that goes stale on the next client. The obligation is per-client coverage, not a literal roster.

The field is `required: true`, so a bundled client missing from it does not degrade gracefully — a reporter using that client MUST select `Other MCP client`, which files a first-class client as a third-party one on every report and corrupts the only structured signal the maintainer has about which client a defect belongs to. `opencode` was absent from May 2026, and `Pi` from its introduction, for exactly this reason: nothing pinned the list to the client set.

#### Scenario: Issue template surfaces in the new-issue UI

- **WHEN** a third party clicks "New Issue" on GitHub
- **THEN** they SHALL be presented with at least the "Bug" and "Feature" templates, with required fields including Reproduction steps, Rembric version, and Client

#### Scenario: Every bundled client is selectable in the bug template's Client field

- **WHEN** the `Client` dropdown in `.github/ISSUE_TEMPLATE/bug.yml` is compared against the set of bundled plugin clients declared by the `development-environment` capability's `apps/plugin/` description
- **THEN** the dropdown SHALL contain one option per bundled client
- **AND** a reporter using any bundled client SHALL NOT have to select `Other MCP client` to file a report
- **AND** the dropdown SHALL retain its non-client options (`Other MCP client`, `Dashboard only`, `Server-side / no client involved`, `N/A`)

#### Scenario: PR template surfaces in the PR creation UI

- **WHEN** a third party opens a PR
- **THEN** the PR description field SHALL be pre-populated with the contributor checklist from `.github/PULL_REQUEST_TEMPLATE.md`
