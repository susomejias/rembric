## MODIFIED Requirements

### Requirement: The dashboard brand block MUST display the running server version

The dashboard SHALL render the running server version (the `version` field of the server package, loaded at boot via `REMBRIC_VERSION` from `apps/web/src/lib/version.ts`) inside the brand block of the desktop sidebar (`.sb-brand`) and the mobile bar (`.mob-bar .brand`), as the line directly under `REMBRIC`. The version SHALL be rendered as a `<small>` element with the text `v<version>` (displayed uppercased by the brand's existing `text-transform`). The brand SHALL NOT render a `SELF-HOSTED` line — the version takes that row. The rendering SHALL reuse the existing `.label-stack small` styles and SHALL NOT introduce new CSS rules.

`REMBRIC_VERSION` resolves from the release manifest `apps/web/package.json` — the file the `server` component's release-please updater bumps and tags `server-v<version>` — falling back to the compose `REMBRIC_VERSION` env pin and finally to the `0.0.0` sentinel.

#### Scenario: Sidebar brand shows the version

- **WHEN** an authenticated operator loads any dashboard page at a desktop viewport with the sidebar expanded
- **THEN** the sidebar brand block SHALL contain, in order, the lines `REMBRIC` and `v<version>` where `<version>` equals the server package version, and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Mobile bar brand shows the version inline

- **WHEN** an authenticated operator loads any dashboard page at a viewport ≤980 px
- **THEN** the `.mob-bar` brand SHALL render `REMBRIC` and `v<version>` inline, with the existing `·` separator applied before the `<small>` by the established `.mob-bar .brand .label-stack small::before` rule

#### Scenario: Collapsed sidebar hides the version with the rest of the label stack

- **WHEN** the sidebar is in collapsed mode
- **THEN** the version SHALL be hidden along with the entire `.label-stack` (existing collapse behavior, unchanged)

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and a footer naming every bundled plugin client

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `v<version>`, where `<version>` is the running server package version loaded via `REMBRIC_VERSION` from `apps/web/src/lib/version.ts`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

A footer SHALL list **every** bundled plugin client, separated visually by lime square bullets, followed by a single generic `MCP CLIENTS` entry **last**. The order SHALL be `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`.

The trailing position of `MCP CLIENTS` is normative and the reason is that it is a **rule a future client can follow**: the footer reads as the bundled clients, then the catch-all. Its previous position between `CODEX CLI` and `HERMES` was not a rule, and a sixth client would have had no way to know where to go. The order among the bundled clients is not derived from any ranking; it is the shipped order and is pinned so the list has one definition rather than drifting per edit.

Omitting a bundled client from this footer is a defect, not a stylistic lag: the login page is the first Rembric surface an operator sees, and a client absent from it reads as unsupported.

The right pane SHALL contain only the admin-token form (a labelled password input + a primary submit button) and SHALL NOT contain redundant section chips or security-disclosure copy that duplicates the `/tokens` documentation.

#### Scenario: Login renders the canonical brand mark

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the response HTML SHALL contain exactly one `<img>` with `src="/dashboard/assets/logo-transparent.png"` inside an element with class `login-brand`, placed before any `<form>` element

#### Scenario: Login brand shows the version instead of SELF-HOSTED

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the brand block SHALL contain the line `v<version>` directly under `REMBRIC` and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Headline is REMBRIC DASHBOARD

- **WHEN** the login page is rendered
- **THEN** the `<h1>` SHALL contain the text `REMBRIC` wrapped in a `<span class="hl-lime">` followed by the text `DASHBOARD` and a period rendered in `var(--lime)`

#### Scenario: Footer names every bundled plugin client, then the generic MCP entry

- **WHEN** the login page is rendered at a viewport width greater than 640 px
- **THEN** the `.login-stage .clients` element SHALL contain, in order, exactly six labelled spans: `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`
- **AND** `MCP CLIENTS` SHALL be the last span

#### Scenario: A test pins the footer list, and it is not vacuous

- **WHEN** the test suite asserts the footer's span list
- **THEN** it SHALL extract the spans from the rendered `/dashboard/login` HTML and compare them against a single canonical list declared once in the test file
- **AND** it SHALL first assert that the extracted list is **non-empty**, so a selector that silently matches nothing cannot pass the comparison
- **AND** deleting the `PI` span from `apps/server/src/server/dashboard-router.ts` SHALL make that test fail

#### Scenario: Login form has no redundant chips or disclosure block

- **WHEN** the login page is rendered
- **THEN** the response HTML SHALL NOT contain the strings `§ 00 / ACCESS`, `OPERATOR DASHBOARD`, `APPEND-ONLY`, `ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, or `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`
