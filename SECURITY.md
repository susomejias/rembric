# Security policy

Thanks for taking the time to disclose a vulnerability responsibly. Rembric is
maintained as a single-process self-hosted server that stores operator memory in
a local SQLite file — security issues in this code base may affect the
integrity, confidentiality, or recoverability of that memory in operator
deployments. We take reports seriously.

## Supported versions

Rembric is pre-1.0. Only **the latest minor release on `main`** is supported for
security fixes; older minors are best-effort. Operators are encouraged to track
the latest published `ghcr.io/susomejias/rembric:v*` tag and follow the upgrade
notes in [docs/docker.md](./docs/docker.md).

| Version line | Supported              |
| ------------ | ---------------------- |
| latest minor | ✅ active fixes        |
| any older    | ❌ best-effort, no SLA |

Once the project ships `v1.0.0`, this policy will be updated with a formal
support window (likely the current and previous minor).

## Reporting a vulnerability

**Preferred:** GitHub Security Advisories. Go to the repository's
[`Security` tab](https://github.com/susomejias/rembric/security/advisories) and
click **Report a vulnerability**. This opens a private channel between you and
the maintainer; do not file a public issue.

**Email fallback:** if you cannot use Security Advisories for any reason
(corporate firewall, anonymous report, …), email **rembric@susomejias.dev**
with subject line `[rembric-security] <short description>`.

When you report, please include:

- Affected version(s) — output of `GET /healthz` from the running server, or the
  tag of the Docker image you pulled.
- Reproduction steps. A minimal reproducer in a fresh `pnpm run dev:docker:up`
  environment is ideal.
- Impact assessment from your end — what an attacker could read, modify, or
  deny.
- Your preferred disclosure timeline (default: see "Disclosure timeline" below).
- Whether you want public credit for the fix and the name / handle / URL you
  want listed.

You do **not** need to provide a fix. We appreciate when reporters do, but a
clear reproducer is enough to act on.

## Acknowledgement and response

- We acknowledge receipt within **5 business days**.
- We aim to triage (confirmed / can't reproduce / out of scope) within **10
  business days**.
- We aim to ship a fix for confirmed high-severity issues within **30 days**.
  Lower-severity issues may roll into the next regular release.

If you do not receive acknowledgement within 5 business days via Security
Advisories, the email fallback above is the right next step. If the email also
goes unanswered for another 5 business days, you may publicly disclose at your
discretion — we will not penalise that.

## Disclosure timeline

Default coordinated disclosure: **90 days from acknowledgement, or 7 days after
a fix is publicly released, whichever comes first**.

Pre-1.0 versions are not eligible for coordinated disclosure beyond best-effort:
because the project is still pre-stable, a "fix" may require an interface
change. We will work with you to find a reasonable disclosure path but cannot
commit to a backward-compatible patch on older minors before v1.0.0.

## Scope

In scope:

- The Rembric server (everything under `src/`).
- The shipped Docker image (`ghcr.io/susomejias/rembric:*`).
- The shared plugin tree (`plugin/`) consumed by the Claude Code / Codex /
  Hermes marketplaces.
- The MCP tool surface and the HTTP API exposed at `/mcp`, `/mcp/<slug>`,
  `/api/<slug>/sessions*`, `/dashboard*`, `/healthz`, and the OAuth 2.1
  endpoints (`/authorize`, `/token`, `/register`, `/revoke`,
  `/.well-known/oauth-*`, `/dashboard/oauth/consent`).

Out of scope (please do **not** spend time on these):

- Vulnerabilities in dependencies that are already in our SBOM and have a
  published advisory — we track these via Dependabot / release-please and will
  pick up patches in the normal release cadence.
- Misconfiguration of the operator's deployment (exposing the server to the
  open internet without TLS, sharing the admin token, etc.) — operationally
  outside the project's control. See the README's "Project status" section
  for the data-protection contract.
- Reports based on third-party security scanners without a demonstrated
  exploit path on a default-configuration `pnpm run dev:docker:up`.
- Best-practice suggestions ("you should use Argon2 instead of bcrypt-style
  hashing") — open a regular issue or PR for these.

## What we will and will not do

- We **will** credit reporters who request it (in the GitHub Advisory and the
  release notes).
- We **will** publish a Security Advisory with the CVE (once assigned) on every
  confirmed high-severity issue.
- We **will not** offer a paid bug bounty.
- We **will not** pursue legal action against good-faith research conducted
  within the scope above.

## Out-of-band questions

This policy itself is a living document. Pull requests welcome.
