# Tasks

## 1. Re-anchor the release manifest and config

- [x] 1.1 `.release-please-manifest.json`: rename key `apps/server` → `apps/web`, value stays `0.28.8`. The `plugin` entry is untouched. This is the load-bearing anti-bootstrap step: manifest mode matches a package to its version by directory path, so config and manifest keys MUST move together.
- [x] 1.2 `release-please-config.json`: rename the `server` package key `apps/server` → `apps/web` and set `package-name: @rembric/web`. `component` stays `server`; `release-type`, `include-component-in-tag`, `include-v-in-tag`, `changelog-path`, the pre-major flags and `changelog-sections` are byte-identical.
- [x] 1.3 `git mv apps/server/CHANGELOG.md apps/web/CHANGELOG.md` (content byte-identical) so the component's `changelog-path: CHANGELOG.md` keeps resolving.
- [x] 1.4 `apps/web/package.json`: `version` `0.0.0` → `0.28.8` (`private: true` retained) — the value the manifest holds, so the next release computes `0.28.9`.

## 2. Release workflow — move the per-path sources, keep the channel

- [x] 2.1 `.github/workflows/release-please.yml`: the `server_release_created`/`server_tag_name` job outputs read `steps.release.outputs['apps/web--release_created']` / `…['apps/web--tag_name']`. The output **names** (`server_release_created`, `server_tag_name`) and therefore the `publish-docker` `if:`/`with:` interface are unchanged.
- [x] 2.2 Refresh the stale header comment that said the publish gates on the `apps/server` path.

## 3. Runtime identity — read the manifest the shipped app owns

- [x] 3.1 `apps/web/src/lib/version.ts`: `SERVER_MANIFEST` → `RELEASE_MANIFEST = join('apps', 'web', 'package.json')`, `readServerManifestVersion` → `readReleaseManifestVersion`, and the docblock rewritten to drop the `apps/server/src/version.ts` claims. Walk-up depth unchanged.
- [x] 3.2 `apps/web/next.config.mjs`: drop the `outputFileTracingIncludes` entry reaching `../../apps/server/package.json` and its comment.
- [x] 3.3 `apps/web/Dockerfile`: add the deterministic runner COPY `COPY --from=builder --chown=10001:10001 /app/apps/web/package.json ./apps/web/package.json`; extend the build gates to fail loudly when the file is missing, when its version is not a semver, or when it is `0.0.0`. Keep the `apps/server/package.json` **builder** copy (pnpm's filtered install resolves the whole lockfile graph; dropping it is P8.3).

## 4. Documentation — path references only

- [x] 4.1 `RELEASING.md`: the component table's `Path`, npm package-name and "bumps when" cells now name `apps/web/` and `@rembric/web`.
- [x] 4.2 `CLAUDE.md:102` (its `AGENTS.md` symlink follows automatically): the `server` component is `apps/web` / `@rembric/web`; tag and Docker semantics unchanged.
- [x] 4.3 `.agents/skills/rembric-plugin-development/SKILL.md:13`: same path/package-name reference.

## 5. OpenSpec change

- [x] 5.1 `proposal.md`, `design.md`, `tasks.md` for `reanchor-server-release-identity`.
- [x] 5.2 `specs/open-source-distribution/spec.md`: MODIFIED "release identity MUST be consistent across surfaces", "docker-publish MUST run only when the server component releases", and "Release-please MUST run as two independent tracks" — full requirement blocks copied verbatim, re-anchored on `apps/web`.
- [x] 5.3 `specs/dashboard/spec.md`: MODIFIED the brand-block version requirement and the login-brand requirement to name `apps/web/src/lib/version.ts`.
- [x] 5.4 Correct the traced-tree sentence in `openspec/changes/publish-web-runtime-image/specs/persistence/spec.md` — the runtime image no longer carries `apps/server/package.json`.
- [x] 5.5 `openspec validate reanchor-server-release-identity --strict` passes.

## 6. Guard test and validation

- [x] 6.1 `scripts/release-please-reanchor.test.ts`: asserts config package keys ≡ manifest keys; that the `server` component's path holds a `package.json` whose version equals its manifest entry (and likewise for every declared component); and that every `<path>--<output>` reference in `release-please.yml` names a declared component path.
- [x] 6.2 Mutation-prove each clause with `scripts/mutate.mjs`: a config key rename, a `package.json` version regression, and a workflow path rename each redden the named test; the tree restores byte-identically.
- [x] 6.3 Probe `release-please@17.6.0` on a throwaway tree: confirm the manifest key derives from the package path, the node strategy writes `0.28.8 → 0.28.9` at `apps/web/package.json`, the tag is `server-v0.28.9`, and the old-path-plus-new-keyed-manifest control misbehaves (proving 1.1 is load-bearing).
- [x] 6.4 `node scripts/mutate.mjs`, `pnpm exec turbo run typecheck --force`, `pnpm run lint`, `pnpm run format:check`, `git diff --check`, apps/web vitest, apps/server invariants, and the OpenSpec gates are all reported in the writer's handoff.
