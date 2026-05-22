# pnpm config snippets

Annotated ready-to-paste blocks for the practices that have a pnpm-native flag.

## `.npmrc` (repo root)

```ini
# Practice #1 — disable all dependency lifecycle scripts by default.
# Exceptions are declared in pnpm-workspace.yaml::onlyBuiltDependencies.
ignore-scripts=true
```

### npm equivalent

```ini
# .npmrc
ignore-scripts=true
# Practice #2 — npm 11.10.0+ only
# allow-git=none
# Practice #3 — npm only
min-release-age=3
```

### yarn (v2+) equivalent

```yaml
# .yarnrc.yml
enableScripts: false
```

---

## `pnpm-workspace.yaml` (repo root)

### pnpm 11+ (current)

```yaml
# Practice #1 — explicit per-package allowlist for lifecycle scripts.
# Native bindings AND git-hook installers usually live here.
# `true` permits the script; `false` is an explicit deny (documents the choice).
allowBuilds:
  husky: true
  better-sqlite3: true
  esbuild: false # transitive of vitest; no install-time binary needed

# Practice #2 — refuse transitive deps fetched from git URLs or
# non-registry tarball URLs. Errors out at install with the offender named.
blockExoticSubdeps: true

# Practice #3 — install cooldown (in minutes). 4320 = 3 days.
# Escape hatch for security patches: lower this value temporarily and
# re-tighten in a follow-up PR, or add packages to minimumReleaseAgeExclude.
minimumReleaseAge: 4320
```

### pnpm 10.x (legacy `onlyBuiltDependencies` list)

```yaml
onlyBuiltDependencies:
  - husky
  - better-sqlite3
blockExoticSubdeps: true
minimumReleaseAge: 4320
```

### Older pnpm (< 10.26) fallback

If you can't bump to pnpm 10.26+, the `onlyBuiltDependencies` allowlist still works (`package.json::pnpm.onlyBuiltDependencies` for pnpm 9). `blockExoticSubdeps` and `minimumReleaseAge` are pnpm 10.26+ only — they have no working pnpm 9 equivalent. The npm CLI has its own `min-release-age` since 11.10.0 but doesn't propagate to pnpm.

---

## `package.json` scripts

```json
{
  "scripts": {
    "lockfile:lint": "lockfile-lint --path pnpm-lock.yaml --type npm --allowed-hosts npm --validate-https --validate-package-names --validate-checksum",
    "preinstall": "pnpm run lockfile:lint"
  },
  "devDependencies": {
    "lockfile-lint": "^4.13.0"
  }
}
```

> **Caveat on `preinstall`:** pnpm 10+ may block the root-package `preinstall` script when `ignore-scripts=true`. Verify empirically before relying on the hook; if it doesn't fire, drop the `preinstall` script and rely on the CI step alone (see `ci-snippets.md`).

---

## Per-PM config locations

| PM   | ignore-scripts                      | allowlist                                        | exotic-block                         | cooldown                               |
| ---- | ----------------------------------- | ------------------------------------------------ | ------------------------------------ | -------------------------------------- |
| npm  | `.npmrc::ignore-scripts=true`       | (no first-class — use `@lavamoat/allow-scripts`) | `.npmrc::allow-git=none` (≥ 11.10)   | `.npmrc::min-release-age` (days)       |
| pnpm | `.npmrc::ignore-scripts=true`       | `pnpm-workspace.yaml::onlyBuiltDependencies`     | `blockExoticSubdeps: true` (≥ 10.26) | `minimumReleaseAge` (minutes, ≥ 10.26) |
| yarn | `.yarnrc.yml::enableScripts: false` | PnP / `dependenciesMeta::built: true`            | manual audit                         | community plugins                      |
| bun  | default off                         | `package.json::trustedDependencies`              | manual audit                         | `bunfig.toml`                          |
