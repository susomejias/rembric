## Why

Rembric has no public product page — the only front door is the GitHub README. A dedicated marketing landing at `rembric.dev` gives the project a shareable, professional presence to drive visibility and adoption, without standing up (or paying for) a server.

## What Changes

- Add a new workspace app `apps/landing` (`@rembric/landing`): a static product landing site for the `rembric.dev` domain.
- Plain HTML + CSS + a small vanilla JS enhancement layer (copy-to-clipboard, mobile menu, live GitHub star count, scroll-reveal) — **no framework, no SPA**, mirroring the dashboard's no-JS-build posture.
- Source authored in `apps/landing/public/` (readable, dev-served); a tiny `esbuild` build (`apps/landing/build.mjs`) minifies JS + CSS into `apps/landing/dist/` (the deploy output). HTML and binary assets are copied verbatim; the host applies Brotli/gzip.
- Reuse the dashboard **design tokens** (palette, self-hosted fonts, favicons, logo) by **copying** them into `apps/landing/public/` — deliberately NOT extracting a shared `packages/styles` package (see design.md; a YAGNI decision that avoids an OpenSpec change against the locked `dashboard` spec).
- Distribution: deployed to **Cloudflare Pages** as a static site with git-integrated auto-deploy. Deliberately **NOT** a release-please component — absent from `release-please-config.json` so it never mints tags or rebuilds the server Docker image.
- Tooling: add `esbuild` (pinned `0.28.0`) as a devDependency of `@rembric/landing`; `eslint.config.js` ignores `apps/landing/public/**` (browser assets) and lints `apps/landing/build.mjs` as a Node script.

This change adds a new deliverable app and does **not** touch any load-bearing invariant (append-only memory, scope-at-service, `topic_key` convergence, judgment freshness), any MCP tool, the `dashboard` spec, or the server image.

## Capabilities

### New Capabilities

- `product-landing`: the static marketing site for `rembric.dev` — its content/structure, the no-framework + copy-tokens authoring model, the esbuild minify build, and its Cloudflare Pages distribution (out of the release-please tracks).

### Modified Capabilities

<!-- None. No existing spec's requirements change. The landing copies dashboard
     tokens rather than modifying the dashboard spec, and is intentionally kept
     out of the open-source-distribution/release tracks. -->

## Impact

- **New app**: `apps/landing/` — `package.json` (`@rembric/landing`, esbuild devDep, `build`/`dev` scripts), `build.mjs`, `README.md`, `.gitignore` (`dist/`), and `public/{index.html, styles/{tokens,landing}.css, scripts/landing.js, assets/{fonts,favicons,logo}}`.
- **Workspace**: `apps/landing` is picked up by the existing `apps/*` glob in `pnpm-workspace.yaml`; `pnpm-lock.yaml` gains the `@rembric/landing` importer + `esbuild@0.28.0`.
- **Lint**: `eslint.config.js` gains an ignore for `apps/landing/public/**` and a Node-script lint block entry for `apps/landing/build.mjs`.
- **Release/CI**: none — `apps/landing` is intentionally excluded from `release-please-config.json`; plugin/server release tracks and the Docker publish are untouched.
- **Deploy target**: Cloudflare Pages (repo root (default), build watch path `apps/landing`, build `pnpm install && pnpm --filter @rembric/landing build`, output `apps/landing/dist`), plus `rembric.dev` DNS.
- **Supply chain**: one new pinned devDependency (`esbuild`); its lifecycle script stays denied under `pnpm-workspace.yaml::allowBuilds` (modern esbuild ships platform binaries via optionalDependencies, so it runs without a postinstall).
