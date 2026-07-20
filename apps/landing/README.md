# @rembric/landing

Static product landing for [rembric](https://github.com/susomejias/rembric),
intended for the `rembric.dev` domain.

## Stack

Plain HTML + CSS + a small vanilla-JS enhancement layer. No framework, no SPA —
mirrors the dashboard's server-rendered HTML approach. Source of truth is
`public/` (readable, dev-served); a tiny esbuild step minifies JS + CSS into
`dist/` for production. HTML, `robots.txt`, `sitemap.xml`, `llms.txt`, and
binary assets are copied verbatim (the host applies Brotli/gzip).

## Design system

`public/styles/tokens.css` is a **temporary copy** of the dashboard design
tokens (`apps/server/src/dashboard/styles/core/{tokens,base}.css`) and fonts.
Once the landing is validated, extract the tokens into a shared workspace
package (`packages/styles`) via an OpenSpec change against the `dashboard`
spec and have both the dashboard and this landing consume it. Until then,
keep the two token files in sync by hand.

## Local preview & build

```sh
pnpm --filter @rembric/landing run dev     # serves readable public/ on :4321
pnpm --filter @rembric/landing run build   # minifies public/ → dist/ via esbuild
```

## Release / distribution

This app is **not** a release-please component — it is deliberately absent from
`release-please-config.json` so it never mints tags or rebuilds the server
image. Deploy it as a static site on **Cloudflare Pages** (git-integrated
auto-deploy) with:

- **Root directory**: repo root (leave default)
- **Build command**: `pnpm install && pnpm --filter @rembric/landing build`
- **Output directory**: `apps/landing/dist`
- **Build watch paths**: `apps/landing/**` (so server-only commits don't rebuild)

Domain: `rembric.dev` (DNS in the same Cloudflare account → automatic HTTPS).
