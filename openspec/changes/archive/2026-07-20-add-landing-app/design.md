## Context

Rembric's only public surface is the GitHub README. We want a shareable product page at `rembric.dev` to raise visibility, with zero recurring hosting cost and no server to babysit. The repo is a pnpm monorepo (`apps/*` deliverables, `packages/*` reserved-but-empty). The dashboard is already server-rendered plain HTML + CSS with self-hosted fonts and a brutalist dark/lime token set that is **locked by the `dashboard` OpenSpec spec**. Release automation is deliberately minimal: exactly two release-please components (`server`, `plugin`); the six-component/cascade model was retired for fragility.

## Goals / Non-Goals

**Goals:**

- A fast, professional static landing that matches Rembric's existing visual identity.
- No recurring cost, no origin server, no maintenance window that can take the site down.
- Follow repo conventions: no-framework HTML/CSS (like the dashboard), strict lint, strict supply-chain policy.
- Minified production output following good practice, with a featherweight toolchain.

**Non-Goals:**

- No CMS, no SPA/framework, no server-side rendering or backend for the landing.
- No extraction of a shared design-token package (explicitly deferred — see Decisions).
- No change to the `dashboard` spec, MCP tools, or any load-bearing invariant.
- Not a release-please component; no Docker image, no tags.

## Decisions

### Plain HTML/CSS + vanilla JS, no framework

Mirrors the dashboard's no-JS-build posture and keeps the artifact tiny and dependency-free at runtime. Astro/Next were considered and rejected as overkill for a single static page with a backend that already lives elsewhere (the Rembric server). The only JS is a ~90-line progressive-enhancement layer (copy buttons, mobile menu, live GitHub stars, scroll-reveal) in one file — splitting into modules would add requests or a bundler for no benefit (YAGNI).

### Copy the dashboard tokens instead of extracting `packages/styles`

The landing only reuses the **token layer** (palette, fonts, favicons, logo) — not dashboard components. That duplication is ~2KB of CSS plus font/asset files that change very rarely (tokens are OpenSpec-locked, i.e. stable). Extracting a shared `packages/styles` package would require an OpenSpec change against the locked `dashboard` spec and move its source of truth — real ceremony for near-zero sync cost. **Decision: copy, don't share.** The copied `tokens.css` carries a comment flagging the sync obligation; revisit extraction only if tokens start to churn. Alternative (shared package now) rejected as premature.

### esbuild for minification (not webpack/rollup)

Per the requirement to ship minified output "following good practice" with a light, fast tool. esbuild minifies both JS and CSS in one Go binary, zero config, millisecond builds — the opposite of webpack's weight. It is pinned to `0.28.0` (a version already resolved in the lockfile, so no new download and no `minimumReleaseAge` cooldown hit). Its lifecycle script stays denied under `allowBuilds` because modern esbuild ships platform binaries via optionalDependencies, not a postinstall. Source stays readable in `public/`; the build emits minified `dist/` (git-ignored). Alternative (no build, rely only on Brotli) considered — for ~2.5KB the wire delta is marginal — but explicit minification was requested, and esbuild makes it near-free.

### Cloudflare Pages over Vercel or a home server

- **Vercel** Hobby (free) ToS is non-commercial-only; a product landing is a gray area with suspension risk. Rejected.
- **Home server** reintroduces exactly the failure mode we want to avoid (site down during maintenance). Cloudflare _can_ mitigate with Always Online + Cache Rules if self-hosting were ever chosen, but that is strictly more moving parts.
- **Cloudflare Pages** hosts the static output on the edge with no origin, free unmetered bandwidth, automatic HTTPS (required for `.app`), git-integrated auto-deploy, and DNS in the same account. Chosen.

### Excluded from release-please

Adding `apps/landing` to the release tracks would risk phantom release PRs and could couple the landing to the server image build. Keeping it absent from `release-please-config.json` means it is a pure static deploy driven only by Cloudflare Pages' git integration.

## Risks / Trade-offs

- **Token drift between landing and dashboard** → Mitigated by the in-file sync comment and the fact that tokens are OpenSpec-locked (rarely change). Revisit extraction if that assumption breaks.
- **New devDependency (`esbuild`) expands the tree** → Mitigated by pinning to an already-resolved version, keeping its lifecycle script denied, and it being build-time only (never shipped to visitors).
- **Cloudflare Pages monorepo rebuilds on unrelated commits** → Mitigated by configuring Build watch paths to `apps/landing/**` so server-only commits don't trigger a landing build.
- **`.app` requires HTTPS everywhere (HSTS preload)** → Non-issue on Cloudflare Pages (auto HTTPS); noted so no HTTP-only path is ever introduced.
- **Content accuracy** → The landing must not fabricate commands/claims; it uses the real `curl … install.sh` install and honest positioning ("any MCP client").

## Migration Plan

1. Land `apps/landing` (source in `public/`, `build.mjs`, package/eslint/gitignore wiring).
2. Create the Cloudflare Pages project: connect the repo (GitHub App), repo root (default), build watch path `apps/landing`, build `pnpm install && pnpm --filter @rembric/landing build`, output `apps/landing/dist`, Build watch paths `apps/landing/**`.
3. Point `rembric.dev` DNS in Cloudflare; verify HTTPS + preview deploys on PRs.
4. Rollback: revert the deploy from the Pages dashboard (immutable versioned deploys) or revert the commit — no data or server impact.

## Open Questions

- None blocking. Optional follow-up: add a `_headers` file for fine-grained long-cache on fingerprint-stable assets (fonts) if desired — not required for launch.
