## REMOVED Requirements

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and client-support footer

**Reason**: Re-added below with the same brand, headline and form obligations, but the footer clause and one scenario **title** had to change. The title `Footer lists all three plugin clients plus generic MCP` states a count in its own title, and the count has been wrong since the fourth client landed. `openspec archive` matches scenarios by header and refuses to drop one, so a `MODIFIED` block cannot rename a scenario; `REMOVED` + `ADDED` is the mechanism this repo already uses for renames (`archive/2026-07-29-align-supply-chain-allowlist`, `archive/2026-06-07-rename-session-get-tool`). The requirement header changes too, because `openspec validate` rejects a same-header `REMOVED` + `ADDED` pair — and because `client-support footer` describes the element without obliging it to name anything.

**Migration**: None for operators. No schema, no data, no configuration. The rendered `/dashboard/login` markup gains a `PI` span and moves `MCP CLIENTS` to last; nothing reads that markup but a browser and the new test. Rollback is an image revert with no residue.

## ADDED Requirements

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and a footer naming every bundled plugin client

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `v<version>`, where `<version>` is the running server package version loaded via `REMBRIC_VERSION`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

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
