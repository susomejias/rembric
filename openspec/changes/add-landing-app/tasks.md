## 1. Scaffold the app

- [x] 1.1 Create `apps/landing/package.json` (`@rembric/landing`, private, `type: module`, `dev` + `build` scripts) — picked up by the `apps/*` workspace glob
- [x] 1.2 Add `.gitignore` with `dist/`
- [x] 1.3 Add `apps/landing/README.md` documenting the no-framework model, the copy-tokens decision, dev preview, and Cloudflare Pages deploy config (output dir `apps/landing/dist`)

## 2. Landing source (apps/landing/public/)

- [x] 2.1 `index.html` — centered hero, marquee, before/after value story, features grid, memory-lifecycle + architecture section, clients (first-class + any-MCP), install (single real `curl … install.sh`), final CTA, footer
- [x] 2.2 `styles/tokens.css` — copied dashboard tokens (palette, `@font-face`, spacing) with a comment flagging it a temporary duplicate to keep in sync with `apps/server/src/dashboard/styles/core/{tokens,base}.css`
- [x] 2.3 `styles/landing.css` — landing-only layout (brutalist, lime accent used sparingly), responsive down to mobile with a working nav hamburger, `prefers-reduced-motion` handling
- [x] 2.4 `scripts/landing.js` — vanilla JS: copy-to-clipboard (with execCommand fallback), mobile menu toggle, live GitHub star count (graceful fallback), scroll-reveal gated behind `html.js`
- [x] 2.5 Copy fonts, favicons (`favicon-{16,32}.png`, `favicon.png`), and `logo{,-transparent}.png` from the dashboard into `public/assets/`; brand lockup uses the logo mark as the "R" initial

## 3. Build & tooling

- [x] 3.1 Add `apps/landing/build.mjs` — esbuild minifies JS+CSS from `public/` → `dist/`, copies HTML + assets verbatim
- [x] 3.2 Add `esbuild` (pinned `0.28.0`) as a devDependency of `@rembric/landing`; confirm it runs under the default-deny `allowBuilds` policy (no lifecycle script needed)
- [x] 3.3 `eslint.config.js`: ignore `apps/landing/public/**`; lint `apps/landing/build.mjs` as a Node script
- [x] 3.4 Verify `pnpm --filter @rembric/landing run build` emits minified `dist/scripts/landing.js` + `dist/styles/*.css`; `pnpm run lint` passes; `pnpm-lock.yaml` diff is limited to the landing importer + esbuild

## 4. Distribution config

- [x] 4.1 Confirm `apps/landing` is absent from `release-please-config.json` (no new component; server/plugin tracks untouched)
- [ ] 4.2 [operator] Create the Cloudflare Pages project: connect the repo via the CF Pages GitHub App, set repo root (default), build watch path `apps/landing`, build command `pnpm install && pnpm --filter @rembric/landing build`, output dir `apps/landing/dist`, and Build watch paths `apps/landing/**`
- [ ] 4.3 [operator] Point `rembric.dev` DNS in Cloudflare and verify automatic HTTPS + PR preview deploys
- [ ] 4.4 [operator] Smoke the production URL: hero, copy buttons, mobile menu, and live star count all work over HTTPS

## 6. SEO & metadata

- [x] 6.1 Complete social/SEO meta in `index.html`: canonical, `og:url`/`og:site_name`/`og:locale`/`og:image` (absolute prod URL + dimensions), Twitter card, `theme-color`, robots
- [x] 6.2 Add JSON-LD structured data (SoftwareApplication / open-source) for rich results
- [x] 6.3 Add `robots.txt` and `sitemap.xml` under `public/`, and copy them in `build.mjs`
- [x] 6.4 Preload the two LCP-critical fonts (Space Grotesk 700, Inter 400) to cut hero render time
- [x] 6.5 Re-run build + lint; confirm `dist/` includes `robots.txt` + `sitemap.xml` and meta renders

## 7. LLM discoverability

- [x] 7.1 Add `public/llms.txt` (llmstxt.org format): H1 + one-line summary blockquote + concise description + curated links (GitHub, quickstart, agent docs) + install command + key facts (license, supported clients, distribution)
- [x] 7.2 Make `robots.txt` explicitly welcome major AI/LLM crawlers (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, anthropic-ai, PerplexityBot, Google-Extended, CCBot) — all Allow
- [x] 7.3 Copy `llms.txt` in `build.mjs`; rebuild and confirm it lands in `dist/`

## 5. Validation

- [x] 5.1 Validate desktop + mobile rendering headless (Playwright): centered hero, before/after, lifecycle, clients, install, footer; no horizontal overflow; hamburger opens/closes
- [ ] 5.2 (optional) Add a `_headers` file in the output for long-cache on fingerprint-stable assets (fonts) if desired
- [ ] 5.3 Run `openspec validate add-landing-app` and archive via `/opsx:archive` once the operator deploy steps (4.2–4.4) are complete
