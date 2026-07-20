## ADDED Requirements

### Requirement: Static landing app under apps/landing

The product landing SHALL live at `apps/landing` as a pnpm workspace member named `@rembric/landing`, authored as plain HTML + CSS + vanilla JS with no framework and no SPA. Its source SHALL live in `apps/landing/public/` and be servable as-is for local development without a build step.

#### Scenario: Landing is a workspace member

- **WHEN** `pnpm install` runs at the repo root
- **THEN** `@rembric/landing` is resolved via the existing `apps/*` glob in `pnpm-workspace.yaml`
- **AND** no framework/SPA runtime dependency is added (only the `esbuild` build-time devDependency)

#### Scenario: Source is directly servable for dev

- **WHEN** a developer serves `apps/landing/public/` with a static file server
- **THEN** the landing renders fully (HTML, CSS, fonts, favicons, logo, and the vanilla JS enhancements) without any build having run

### Requirement: esbuild minify build to dist/

The landing SHALL provide a `build` script that minifies JS and CSS from `apps/landing/public/` into `apps/landing/dist/` using `esbuild`, copying HTML and binary assets verbatim. `dist/` is the deploy output and SHALL be git-ignored. `esbuild` SHALL be a pinned devDependency of `@rembric/landing` whose install lifecycle script remains denied by the repo's supply-chain policy.

#### Scenario: Build produces minified output

- **WHEN** `pnpm --filter @rembric/landing run build` runs
- **THEN** `apps/landing/dist/` contains minified `scripts/landing.js` and `styles/*.css`, plus `index.html` and `assets/` copied verbatim

#### Scenario: dist is not committed

- **WHEN** the repository is inspected
- **THEN** `apps/landing/dist/` is absent from version control (git-ignored)

#### Scenario: esbuild runs without a lifecycle script

- **WHEN** `esbuild` is installed under the repo's default-deny `allowBuilds` policy (`esbuild: false`)
- **THEN** the build still runs, because the platform binary is provided via optionalDependencies rather than a postinstall script

### Requirement: Reuse dashboard design tokens by copying

The landing SHALL reuse the dashboard design tokens (palette, self-hosted fonts, favicons, logo) by copying them into `apps/landing/public/`, NOT by importing a shared package. The copied `apps/landing/public/styles/tokens.css` SHALL carry a comment marking it a temporary duplicate to keep in sync with `apps/server/src/dashboard/styles/core/{tokens,base}.css`. This change SHALL NOT modify the `dashboard` spec or its locked tokens.

#### Scenario: Tokens are copied, not shared

- **WHEN** the landing's styles are inspected
- **THEN** `apps/landing/public/styles/tokens.css` is a self-contained copy of the dashboard tokens and fonts
- **AND** no `packages/styles` package is created and the `dashboard` spec is unchanged

#### Scenario: Copy is documented as a sync obligation

- **WHEN** a reader opens `apps/landing/public/styles/tokens.css`
- **THEN** a comment states it is a temporary copy of the dashboard tokens to be kept in sync (and points at where the source lives)

### Requirement: Landing is excluded from the release tracks

The landing SHALL NOT be a release-please component: it SHALL be absent from `release-please-config.json`, so a commit touching `apps/landing` never mints a tag nor rebuilds or republishes the server Docker image.

#### Scenario: Landing commit does not trigger a release

- **WHEN** a commit changes only files under `apps/landing/`
- **THEN** release-please opens no release PR for the landing and the server/plugin release tracks and Docker publish are untouched

### Requirement: Static hosting on Cloudflare Pages

The landing SHALL be distributed as a static site on Cloudflare Pages via git-integrated auto-deploy — no origin server to maintain. The deploy SHALL use repo root (default), build command `pnpm install && pnpm --filter @rembric/landing build`, and output directory `apps/landing/dist`.

#### Scenario: Auto-deploy on push to main

- **WHEN** a change to `apps/landing` is pushed to `main`
- **THEN** Cloudflare Pages builds via the configured command and publishes `apps/landing/dist` to `rembric.dev` over HTTPS

#### Scenario: No server-side runtime

- **WHEN** the landing is served in production
- **THEN** it is served entirely as static assets from Cloudflare's edge, with no Rembric server or other origin in the request path
