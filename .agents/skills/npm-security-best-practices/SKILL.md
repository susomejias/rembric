---
name: npm-security-best-practices
description: Apply npm/pnpm supply-chain hardening when adding a dependency, editing package.json/.npmrc/pnpm-workspace.yaml, reviewing a lockfile change, or configuring CI install steps. Covers the 17 practices from lirantal/npm-security-best-practices.
---

# npm Security Best Practices

A general reference for hardening any npm-ecosystem project (npm, pnpm, yarn, bun) against supply-chain attacks. Adapted from [lirantal/npm-security-best-practices](https://github.com/lirantal/npm-security-best-practices). Use this skill whenever you are about to add a dependency, edit install-time configuration, review a lockfile diff, or configure CI install steps.

For the project-specific snapshot date, upstream commit SHA, and quarterly re-read reminder, see [references/source.md](./references/source.md). For a one-page scan-friendly summary, see [references/checklist.md](./references/checklist.md). For ready-to-paste configs, see [references/pnpm-config.md](./references/pnpm-config.md) and [references/ci-snippets.md](./references/ci-snippets.md).

---

## 1. Disable post-install scripts

Lifecycle scripts (`preinstall`, `install`, `postinstall`, dependency-side `prepare`) run during `npm install` against every transitive dep. Compromised packages exfiltrate secrets or install malware from these hooks. The default-deny stance: block all of them, then allowlist exceptions.

### How to apply

**npm / pnpm (≤ 9):** set `ignore-scripts=true` in `.npmrc`. Per-install override: `npm install --ignore-scripts`.

**pnpm 10.x:** combine `.npmrc::ignore-scripts=true` with `pnpm-workspace.yaml::onlyBuiltDependencies: [pkg1, pkg2]` for an auditable allowlist.

**pnpm 11+:** the legacy `onlyBuiltDependencies` list is replaced by an explicit `pnpm-workspace.yaml::allowBuilds:` map with per-package booleans. Lifecycle scripts that aren't listed default to denied; `false` is allowed for explicit-deny documentation. Native bindings (`better-sqlite3`, `sharp`, etc.) and tools that need git-hook setup (`husky`) typically go here:

```yaml
allowBuilds:
  husky: true
  better-sqlite3: true
  esbuild: false # explicit deny, documents the choice
```

**bun:** scripts are disabled by default. Allowlist via `trustedDependencies` in `package.json`.

**yarn (v2+):** native bindings work via PnP / Plug'n'Play; for v1 use `--ignore-scripts`.

**Audit-grade alternative:** [`@lavamoat/allow-scripts`](https://github.com/LavaMoat/LavaMoat) — independent of the package manager, lists explicitly approved scripts.

---

## 2. Block git-based and exotic dependency sources

Transitive deps fetched from git URLs or arbitrary tarball URLs bypass registry signing, provenance, and most static analysis. A legitimate package can ship a transitive dep that resolves to `git+https://attacker/foo.git` and you've effectively imported attacker-controlled code with no review.

### How to apply

**npm 11.10.0+:** `npm config set allow-git none` or per-install `npm install --allow-git=none`.

**pnpm 10.26+:** `pnpm-workspace.yaml::blockExoticSubdeps: true`. Refuses git URLs and non-registry tarball URLs for transitive deps. Errors out at install with the offending package named.

**yarn / bun:** no first-class flag at time of writing. Audit `yarn.lock` / `bun.lock` for `git+`, `http://`, or off-registry hosts.

---

## 3. Install with cooldown

The first 24–72 hours of a new package version is the prime window for compromised publishes to be detected and unpublished. Refusing brand-new versions buys community time without meaningfully delaying patch adoption.

### How to apply

**npm:** `.npmrc::min-release-age=3` (days). Per-install: `npm install <pkg> --before=2026-01-01`.

**pnpm 10.26+:** `pnpm-workspace.yaml::minimumReleaseAge: 4320` (minutes — 3 days). Escape hatch for genuine security patches: `pnpm install --no-minimum-release-age`.

**bun:** see Bun's [`install` config](https://bun.sh/docs/runtime/bunfig).

**Default suggestion:** 3 days is a defensible middle ground. Shorter (24h) misses weekend incidents; longer (14d+) delays legitimate patches.

---

## 4. Harden installs with security tools

### 4.1 npq

[`npq`](https://github.com/lirantal/npq) wraps `npm install` and validates against Snyk's CVE DB, package age, typosquatting heuristics, registry signatures, provenance, suspicious scripts, and overall package health.

```bash
npm install -g npq
npq install <package>                              # npm-style
NPQ_PKG_MGR=pnpm npq install <package>             # pnpm
```

Best for **manual dep additions** — not a substitute for the policy flags above.

### 4.2 Socket Firewall (sfw)

[`sfw`](https://socket.dev/blog/introducing-socket-firewall) intercepts ALL installs and blocks packages flagged by Socket's threat intel (malicious scripts, typosquatting, dependency confusion, suspicious network/filesystem access).

```bash
npm install -g sfw
sfw npm install
sfw pnpm install
```

More aggressive than `npq`. Vendor lock-in to Socket; full features require a Socket account. Best fit for orgs that want install-time defense as a paid service.

---

## 5. Prevent lockfile injection

A malicious PR can edit `package-lock.json` or `pnpm-lock.yaml` to swap a tarball URL or remove the checksum without changing `package.json`. `lockfile-lint` validates the lockfile against a security policy.

### How to apply

```bash
npm install --save-dev lockfile-lint
npx lockfile-lint \
  --path pnpm-lock.yaml \
  --type npm \
  --allowed-hosts npm \
  --validate-https \
  --validate-package-names \
  --validate-checksum
```

Wire as a `preinstall` script AND as a dedicated CI step BEFORE any install. Two enforcement points — `preinstall` catches local drift, CI catches the malicious PR before merge.

`pnpm-workspace.yaml::blockExoticSubdeps: true` (practice #2) covers a subset of the same attack class for pnpm specifically; the two are complementary.

---

## 6. Use deterministic installs in CI

Lockfiles must be respected to be useful. Tooling that "silently updates the lockfile if it doesn't match `package.json`" defeats the purpose.

### How to apply

| Tool | Command                                      |
| ---- | -------------------------------------------- |
| npm  | `npm ci`                                     |
| pnpm | `pnpm install --frozen-lockfile`             |
| yarn | `yarn install --immutable --immutable-cache` |
| bun  | `bun install --frozen-lockfile`              |
| deno | `deno install --frozen`                      |

Commit the lockfile to version control. The CI install step SHALL fail when the lockfile disagrees with `package.json`.

---

## 7. Avoid blind dependency upgrades

`npm update`, `npm-check-updates -u`, and similar "bump everything" tools mask supply-chain attacks behind a wall of green checks. Use reviewed update flows instead.

### How to apply

- **Interactive review:** `npx npm-check-updates --interactive` — opt in to each bump.
- **Automated with policy:** Dependabot / Snyk / Renovate. Configure to open PRs (not auto-merge), batch by minor/major, and require approval.
- **Manual one-at-a-time bumps** when the dep is sensitive (auth libs, crypto, native bindings).

Coupled with practice #3 (cooldown), this prevents "bumped to 1.2.3 published 5 minutes ago" surprises.

---

## 8. Harden `npx` execution

`npx` arbitrary-package execution is a remote code execution primitive. Pre-install in a vetted workspace, then force offline execution.

### How to apply

```bash
# One-time setup: create a vetted workspace
mkdir -p $HOME/mcp && cd $HOME/mcp
npm init -y
npm install <package> --save

# Every invocation: offline, no downloads
npx --include-workspace-root --workspace $HOME/mcp --no --offline <package>
```

`--no` refuses to download; `--offline` rejects any network. Only applicable when you have a small, stable set of `npx` targets (e.g., MCP servers).

If you don't use `npx` at all in your project, skip this practice.

---

## 9. No plaintext secrets in `.env`

`.env` files leak via misconfigured backups, accidental commits, IDE auto-sync to cloud, malware reading `process.env`. Use secret references that resolve at runtime through a vault.

### How to apply

```bash
# .env (committable references, NOT plaintext)
DATABASE_PASSWORD=op://vault/prod-db/password
API_KEY=infisical://project/prod/api-key

# Runtime
op run -- npm start                  # 1Password CLI
op run --env-file=.env -- node server.js
infisical run --env=prod -- npm start
```

Local development secrets (a token only used against `localhost`) are a defensible exception. Production secrets are not.

---

## 10. Develop in containers

A malicious `postinstall` script with file-system access to your `~/.ssh/`, `~/.aws/`, browser profile, and password manager is game over. Isolating dev environments inside containers limits the blast radius.

### How to apply

```jsonc
// .devcontainer/devcontainer.json
{
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm",
  "postCreateCommand": "corepack enable && pnpm install",
  "remoteUser": "node",
  "runArgs": ["--security-opt=no-new-privileges:true"],
  "forwardPorts": [3000],
}
```

For stronger isolation, combine with capability drops and a read-only root filesystem. Container ≠ sandbox; assume escape is possible and don't put production secrets inside.

---

## 11. Enable 2FA on npm publisher accounts

Targeted phishing of maintainer accounts has been the entry point for several major npm incidents (`event-stream`, `coa`, `ua-parser-js`).

### How to apply

```bash
npm profile enable-2fa auth-and-writes    # required for publishing
# OR
npm profile enable-2fa auth-only          # login + profile changes
```

`auth-and-writes` is the right choice for any account that publishes. WebAuthn / passkeys preferred over TOTP.

Skip if you don't publish to npm.

---

## 12. Publish with provenance attestations

[npm provenance](https://docs.npmjs.com/generating-provenance-statements) creates a cryptographic chain `(source commit, CI workflow run, published tarball)` so consumers can verify the package matches the repository at the claimed commit.

### How to apply

```yaml
# .github/workflows/publish.yml
permissions:
  id-token: write # OIDC token for the attestation
  contents: read

steps:
  - uses: actions/checkout@v4
  - run: npm publish --provenance
```

Requires npm CLI 9.5.0+ and a supported CI platform (GitHub Actions, GitLab CI, CircleCI).

Skip if you don't publish to npm.

---

## 13. Publish with OIDC trusted publishing

[Trusted publishing](https://docs.npmjs.com/trusted-publishers) eliminates long-lived npm tokens. The CI workflow exchanges an OIDC identity for a short-lived publish token scoped to the package.

### How to apply

1. Configure a trusted publisher on `npmjs.com` for your package, pinning the GitHub org + repo + workflow file path.
2. In the publish workflow:
   ```yaml
   permissions:
     id-token: write
   steps:
     - run: npm publish # no --auth-token, no NPM_TOKEN secret
   ```

A leaked CI token is now non-fungible: it cannot be reused outside the configured workflow.

Skip if you don't publish to npm.

---

## 14. Reduce your dependency tree

Each direct dep multiplies the attack surface by its transitive closure. Modern JavaScript runtimes have absorbed most of what historic utility libraries provided.

### How to apply

| Instead of                    | Use                                                 |
| ----------------------------- | --------------------------------------------------- |
| `lodash.uniq`                 | `[...new Set(array)]`                               |
| `lodash.merge`                | `{ ...a, ...b }` / structured clone                 |
| `axios`                       | `fetch()` (native in Node 18+, all modern browsers) |
| `node-fetch`                  | `fetch()`                                           |
| `uuid`                        | `crypto.randomUUID()` (Node 19+, browsers)          |
| `date-fns`                    | `Temporal` (staged), `Intl.DateTimeFormat`          |
| `chalk`                       | ANSI escape strings + a 5-line helper               |
| `commander` (single-verb CLI) | Hand-roll `process.argv` parsing                    |

Don't audit-shame existing deps — replacement is a project, not a hygiene step. Apply when ADDING a new dep.

---

## 15. Consult the Snyk Security Database

Beyond CVEs: package health, maintenance signals, popularity trends, dependency-vulnerability counts.

### How to apply

Before adding a dep, search [security.snyk.io](https://security.snyk.io). Look at:

- Open CVEs / unpatched vulnerabilities
- Last-publish age (dormant projects don't ship fixes)
- Maintainers count (bus-factor ≥ 2 preferred)
- Number of direct dependents (popularity signal)
- Issue/PR responsiveness

Cross-reference with the npm page and the GitHub repo. If signals diverge, treat the lower-trust signal as the truth.

---

## 16. Do not trust the npmjs.org registry metadata

The npm website's package page is a curated, **incomplete** view. The actual installed tarball can contain files not listed in the registry metadata, including build artifacts, `.env.example` references that leak structure, or surprise binaries.

### How to apply

```bash
# Before adopting a package: pull and inspect
npm pack <package>            # creates <pkg>-<ver>.tgz
tar -tzf <pkg>-<ver>.tgz       # list contents
tar -xzf <pkg>-<ver>.tgz       # extract for review
```

Or use `npq` (practice #4.1) which inspects multiple data sources.

---

## 17. Prevent dependency confusion

If you publish a private internal package `@yourorg/secret-tool` to your private registry, an attacker can publish `@yourorg/secret-tool` to the **public** npm registry. Default npm resolution favors the version with the higher version number — attacker wins.

### How to apply

```ini
# .npmrc
@yourorg:registry=https://npm.yourcompany.com/
//npm.yourcompany.com/:_authToken=${NPM_INTERNAL_TOKEN}
```

This routes the `@yourorg` scope **exclusively** to the private registry, regardless of what exists on `npmjs.org`. For yarn v2+, the equivalent is `npmScopes` in `.yarnrc.yml`.

Practice depends on the package name being scoped (`@org/name`, not `bare-name`). Unscoped private packages cannot be protected this way.

---

## Per-package-manager support matrix

| Practice         | npm                                       | pnpm                           | yarn                     | bun                 |
| ---------------- | ----------------------------------------- | ------------------------------ | ------------------------ | ------------------- |
| 1 ignore-scripts | `.npmrc`                                  | `.npmrc` + workspace allowlist | `--ignore-scripts` / PnP | default off         |
| 2 block exotic   | `npm config set allow-git none` (≥ 11.10) | `blockExoticSubdeps` (≥ 10.26) | manual audit             | manual audit        |
| 3 cooldown       | `min-release-age`                         | `minimumReleaseAge` (≥ 10.26)  | community plugins        | `bunfig.toml`       |
| 5 lockfile-lint  | ✅                                        | ✅                             | ✅                       | ✅ (use --type bun) |
| 6 deterministic  | `npm ci`                                  | `--frozen-lockfile`            | `--immutable`            | `--frozen-lockfile` |
| 11 2FA           | ✅                                        | (uses npm registry)            | (uses npm registry)      | (uses npm registry) |
| 12 provenance    | `--provenance` (≥ 9.5)                    | via `npm publish`              | via `npm publish`        | via `npm publish`   |
| 13 OIDC          | ✅                                        | (uses npm registry)            | (uses npm registry)      | (uses npm registry) |

---

## Adoption priority (when starting from zero)

If you can only adopt 5 practices, do these first:

1. **#6 deterministic installs** — zero cost, immediate guarantee
2. **#1 ignore-scripts + allowlist** — blocks the most common attack
3. **#5 lockfile-lint in CI** — catches injection at PR time
4. **#3 cooldown** — buys time for community detection
5. **#11 2FA on the publisher account** — if you publish, this is non-negotiable

The remaining 12 are layered defenses, not prerequisites.
