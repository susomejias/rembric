# Tasks

## 1. Composite action — parameterize it without moving any existing caller

- [x] 1.1 `.github/actions/build-runtime-image/action.yml`: add `dockerfile` (default `./apps/server/Dockerfile`) and `target` (default `runtime`) inputs; update the action description to say the Dockerfile and stage are inputs.
- [x] 1.2 Both build modes (`load`, `digest`) read `${{ inputs.dockerfile }}` and `${{ inputs.target }}` — no hard-coded path or stage survives. Verified by parsing the action: `file/target per step = ${{ inputs.dockerfile }} / ${{ inputs.target }} | ${{ inputs.dockerfile }} / ${{ inputs.target }}`.
- [x] 1.3 `ci.yml` is left untouched functionally: its call omits both inputs, so it keeps building `apps/server/Dockerfile`'s `runtime` stage.

## 2. Publish workflow — build and smoke the web image under the unchanged channel

- [x] 2.1 `docker-publish.yml`: pass `dockerfile: ./apps/web/Dockerfile` and `target: runner` to the composite action. Image name (`ghcr.io/${{ github.repository_owner }}/rembric`), tag scheme, triggers, auth, platform policy and merge job unchanged.
- [x] 2.2 Move the publish's cache scope to `web-runtime-${{ matrix.arch }}` — the scope `docker-build-check-web` writes for the same Dockerfile — so the merge-to-main preceding a release leaves the publish warm (parsed: `cache-scope=web-runtime-${{ matrix.arch }}`).
- [x] 2.3 Signal 1 of the per-arch smoke asserts the web entrypoint (`EXPECT_ENTRY='apps/web/server.js'`, used by both the grep and its error message). Signals 2 (label `rembric.stage=runtime`) and 3 (1500 MB ceiling) are unchanged verbatim.
- [x] 2.4 The `apps/server` image publication stops: nothing else in the workflow consumed it. `apps/server/Dockerfile` is still built and booted by `ci.yml` for the installer e2e.

## 3. Invariants — a two-sided guard

- [x] 3.1 Replace the `target: runtime` check with a parameterization check: both build modes consume `inputs.dockerfile`/`inputs.target` (a re-hard-coded leg fails), and each default is anchored inside its own input block (so a moved or commented-out `default:` fails).
- [x] 3.2 Add the publish-side check: exactly one uncommented `dockerfile: ./apps/web/Dockerfile`, exactly one uncommented `target: runner`, the workflow still references the shared action, the smoke's expected entrypoint is `apps/web/server.js`, and `dist/server-entrypoint.js` no longer appears in the workflow.
- [x] 3.3 Mutation-check both guards with `scripts/mutate.mjs`: 10 mutations, 10 caught, tree restored byte-identically. Mutations covered: dockerfile default, target default, each build mode's `file`/`target` input usage (individually), the publish's dockerfile override, that override commented out, the publish's target override, the `uses:` reference, and the smoke's expected entrypoint.

## 4. Stale comments

- [x] 4.1 `action.yml` description: no longer says it builds `apps/server/Dockerfile` unconditionally.
- [x] 4.2 `docker-publish.yml`: header states which artifact publishes, and the cache-scope comment names `docker-build-check-web` instead of the server build.
- [x] 4.3 `ci.yml`: the server runtime cache scope is documented as CI-local (the publish now uses `web-runtime-<arch>`), and `docker-build-check-web` states that it gate-builds the published artifact and shares its scope with the publish.

## 5. Spec deltas (this change folder)

- [x] 5.1 `specs/development-environment/spec.md`: MODIFIED "CI MUST verify both Dockerfile stages build cleanly on every change" — publish builds the web image through the parameterized action; smoke asserts the web entrypoint; the `apps/web/Dockerfile` structure is required as the published artifact; the composite action's inputs and defaults are specified; scenarios for the web publish, the fallback-to-server failure, both invariant guards, and the CI defaults.
- [x] 5.2 `specs/persistence/spec.md`: MODIFIED "The distributed Docker image MUST NOT execute destructive data operations on startup" — published entrypoint is `node /app/apps/web/server.js`; prohibition, seed-script clause and data-preservation scenario retained; verification restated for the per-arch-digest smoke and the workflow/Dockerfile expectation chain.
- [x] 5.3 `openspec validate publish-web-runtime-image --strict` passes.

## 6. Validation

- [x] 6.1 `pnpm exec vitest run src/test/invariants.test.ts` (from `apps/server`): 104 passed. Focused filter `-t "image packaging invariants"`: 7 passed.
- [x] 6.2 Mutation checks (task 3.3): all 10 caught.
- [x] 6.3 YAML parse (js-yaml from the pnpm store) of all three changed YAML files + `bash -n` on every `run:` block (30 blocks, 0 failures).
- [x] 6.4 `git diff --check`, `pnpm run lint`, `pnpm run format:check`, `pnpm exec turbo run typecheck --force` — all clean.
- [ ] 6.5 End-to-end publish dry run (`workflow_dispatch` against a throwaway tag): confirm both native jobs build the web image, smoke passes on both arches, the merge job mints the manifest list and aliases, and no tag is created when an arch fails. Not run — requires pushing a tag through the release pipeline.
- [ ] 6.6 Measure the web image size per arch against the 1500 MB ceiling. Not measured: the build is a multi-minute multi-arch Docker build and no runner measurement exists yet. The ceiling fails closed at publish time (before any tag), so the risk is a blocked release rather than a bad image — see `design.md` D5.
- [ ] 6.7 First-release verification on a real installation: the operator's `docker pull` / compose `${REMBRIC_VERSION:-latest}` path resolves the same tags, and the updater's `rembric.stage=runtime` prune filter still matches the published image. Post-merge.
- [ ] 6.8 Archive this change (merging both deltas into `openspec/specs/`) once 6.5 has passed on a real release.
