# Delta — dashboard

## ADDED Requirements

### Requirement: The dashboard brand block MUST display the running server version

The dashboard SHALL render the running server version (the `version` field of the server package, loaded at boot via `REMBRIC_VERSION` from `apps/server/src/version.ts`) inside the brand block of the desktop sidebar (`.sb-brand`) and the mobile bar (`.mob-bar .brand`), as the line directly under `REMBRIC`. The version SHALL be rendered as a `<small>` element with the text `v<version>` (displayed uppercased by the brand's existing `text-transform`). The brand SHALL NOT render a `SELF-HOSTED` line — the version takes that row. The rendering SHALL reuse the existing `.label-stack small` styles and SHALL NOT introduce new CSS rules.

#### Scenario: Sidebar brand shows the version

- **WHEN** an authenticated operator loads any dashboard page at a desktop viewport with the sidebar expanded
- **THEN** the sidebar brand block SHALL contain, in order, the lines `REMBRIC` and `v<version>` where `<version>` equals the server package version, and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Mobile bar brand shows the version inline

- **WHEN** an authenticated operator loads any dashboard page at a viewport ≤980 px
- **THEN** the `.mob-bar` brand SHALL render `REMBRIC` and `v<version>` inline, with the existing `·` separator applied before the `<small>` by the established `.mob-bar .brand .label-stack small::before` rule

#### Scenario: Collapsed sidebar hides the version with the rest of the label stack

- **WHEN** the sidebar is in collapsed mode
- **THEN** the version SHALL be hidden along with the entire `.label-stack` (existing collapse behavior, unchanged)

## MODIFIED Requirements

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and client-support footer

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `v<version>`, where `<version>` is the running server package version loaded via `REMBRIC_VERSION`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

A footer SHALL list the supported plugin clients in the following order, separated visually by lime square bullets: `CLAUDE CODE`, `CODEX CLI`, `HERMES`, `MCP CLIENTS`. The right pane SHALL contain only the admin-token form (a labelled password input + a primary submit button) and SHALL NOT contain redundant section chips or security-disclosure copy that duplicates the `/tokens` documentation.

#### Scenario: Login renders the canonical brand mark

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the response HTML SHALL contain exactly one `<img>` with `src="/dashboard/assets/logo-transparent.png"` inside an element with class `login-brand`, placed before any `<form>` element

#### Scenario: Login brand shows the version instead of SELF-HOSTED

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the brand block SHALL contain the line `v<version>` directly under `REMBRIC` and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Headline is REMBRIC DASHBOARD

- **WHEN** the login page is rendered
- **THEN** the `<h1>` SHALL contain the text `REMBRIC` wrapped in a `<span class="hl-lime">` followed by the text `DASHBOARD` and a period rendered in `var(--lime)`

#### Scenario: Footer lists all three plugin clients plus generic MCP

- **WHEN** the login page is rendered at a viewport width greater than 640 px
- **THEN** the `.login-stage .clients` element SHALL contain, in order, four labelled spans `CLAUDE CODE`, `CODEX CLI`, `HERMES`, `MCP CLIENTS`

#### Scenario: Login form has no redundant chips or disclosure block

- **WHEN** the login page is rendered
- **THEN** the response HTML SHALL NOT contain the strings `§ 00 / ACCESS`, `OPERATOR DASHBOARD`, `APPEND-ONLY`, `ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, or `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`
