# Design — show-server-version-in-dashboard-brand

## Context

The dashboard brand block renders `REMBRIC` + `SELF-HOSTED` in three places: the desktop sidebar (`renderSidebar`, stacked `<small>` lines), the mobile bar (`renderMobileBar`, inline `label-stack` where each `<small>` gets a `·` prefix via `.mob-bar .brand .label-stack small::before`), and the login page (`renderLogin` in `dashboard-router.ts`, two `t-mono-up fg-dim` lines). A boot-time version constant already exists: `REMBRIC_VERSION` in `apps/server/src/version.ts` (reads `apps/server/package.json`, falls back to `0.0.0`).

## Goals / Non-Goals

**Goals:**

- Operator can read the running server version from any dashboard surface, desktop and mobile, including the login page.
- Leaner brand: `SELF-HOSTED` removed everywhere; the version takes its row.
- Zero new CSS, zero new dependencies, zero runtime cost beyond one already-existing constant.

**Non-Goals:**

- Update-available checks, changelog links, or remote version comparison.
- Exposing version via a new HTTP endpoint (out of scope; this is SSR-only).

## Decisions

1. **Source: `REMBRIC_VERSION` constant** — already loaded at boot from `package.json`, already battle-tested elsewhere in the server. Alternatives considered: reading `package.json` inside `components.ts` (duplicates the loader), an env var (operator burden, drifts from the actual image), a `/health` fetch (client JS for static data — violates the no-framework rule).
2. **Render: the version replaces the `SELF-HOSTED` line** — `<small>v${REMBRIC_VERSION}</small>` in sidebar/mob-bar `label-stack`s, a `t-mono-up fg-dim` line in the login brand. `text-transform: uppercase` renders it as `V0.21.1`. In the mobile bar the existing `::before` separator rule yields `REMBRIC · V0.21.1` with no CSS change. Alternative considered: keeping `SELF-HOSTED` and stacking the version as a third line — rejected by the operator (2026-06-06): `SELF-HOSTED` carries no information on an instance you are by definition self-hosting, and dropping it removes any mobile-overflow risk.
3. **Version shown on the login page (pre-auth)** — initial design excluded it as version-disclosure hardening; the operator explicitly overrode (2026-06-06): deployments are VPN/LAN-fronted per docs/docker.md, the bearer token is the security boundary, and brand consistency wins. The delta spec modifies the existing login-brand requirement accordingly.
4. **Collapsed sidebar hides the version** — `.sb.is-collapsed .sb-brand .label-stack { display: none }` already hides the whole stack; no special handling. Alternative (tooltip on the logo) rejected as unnecessary chrome.

## Risks / Trade-offs

- [Trade-off] Exact version visible pre-auth aids vulnerability fingerprinting → Accepted because Rembric's documented posture fronts the port with VPN/Tailscale/LAN trust and the bearer token is the real boundary; operator explicitly chose this.
- [Trade-off] Version invisible in collapsed sidebar → Accepted because the mobile bar and any expanded view still show it, and collapsed mode is icons-only by design.
- ~~[Risk] Mobile bar overflow on narrow viewports~~ — eliminated by dropping `SELF-HOSTED`; `REMBRIC · V0.21.1` fits comfortably at 360 px.
