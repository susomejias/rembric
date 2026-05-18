# CI snippets

Copy-paste GitHub Actions blocks for the practices that have a CI surface.

## Lockfile validation (practice #5)

Place BEFORE any install step. Pinning `lockfile-lint` defends against a compromise of the tool itself.

```yaml
- uses: actions/checkout@v4

- uses: actions/setup-node@v4
  with:
    node-version: '22'

- name: Enable corepack
  run: corepack enable

- name: Cache pnpm store
  uses: actions/cache@v4
  with:
    path: ~/.local/share/pnpm/store
    key: ${{ runner.os }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}

- name: Validate lockfile
  run: npx --yes lockfile-lint@4.13.0 --path pnpm-lock.yaml --type npm --allowed-hosts npm --validate-https --validate-package-names --validate-checksum

- name: Install
  run: pnpm install --frozen-lockfile
```

For npm-managed projects, change `--path pnpm-lock.yaml` to `--path package-lock.json` and the install step to `npm ci`.

---

## Deterministic install (practice #6)

| PM   | Step body                             |
| ---- | ------------------------------------- |
| npm  | `run: npm ci`                         |
| pnpm | `run: pnpm install --frozen-lockfile` |
| yarn | `run: yarn install --immutable`       |
| bun  | `run: bun install --frozen-lockfile`  |

---

## Socket Firewall wrapper (practice #4.2, optional)

```yaml
- name: Install Socket Firewall
  run: npm install -g sfw

- name: Install with Socket Firewall
  run: sfw pnpm install --frozen-lockfile
```

Slower than a normal install (each request is proxied through Socket). Best for orgs that already pay for Socket; redundant with `lockfile-lint` + `blockExoticSubdeps` + `minimumReleaseAge` for the most common cases.

---

## Publish with provenance + OIDC (practices #12 + #13)

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # OIDC for trusted publishing AND provenance
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - run: corepack enable

      - run: pnpm install --frozen-lockfile

      - run: pnpm run build

      # No NPM_TOKEN needed when trusted publisher is configured on npmjs.com.
      # npm CLI ≥ 9.5.0 picks up the OIDC token automatically.
      - run: npm publish --provenance
```

**One-time setup on npmjs.com:**

1. Sign in to `npmjs.com` as the package maintainer.
2. Open the package's "Settings" → "Trusted Publishers" → "Add publisher".
3. Pin: GitHub org, repository name, workflow filename (`publish.yml`), environment name (if any).
4. Confirm. The next publish via this exact workflow gets an OIDC-issued short-lived token automatically.

**2FA setup (practice #11):**

```bash
npm profile enable-2fa auth-and-writes
```

Prefer WebAuthn / passkey over TOTP. Required for any account that owns packages.

---

## Quarterly security audit (optional, low-effort)

```yaml
name: Weekly security audit

on:
  schedule:
    - cron: '0 9 * * MON' # Monday 09:00 UTC
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write

    steps:
      - uses: actions/checkout@v4
      - run: pnpm audit --audit-level=moderate || echo "::warning::audit found issues"
      - run: npx --yes lockfile-lint@4.13.0 --path pnpm-lock.yaml --type npm --allowed-hosts npm --validate-https --validate-package-names --validate-checksum
```

Catches new CVEs against your locked tree without bumping anything. Use `gh issue create` on failure to file a ticket for triage.
