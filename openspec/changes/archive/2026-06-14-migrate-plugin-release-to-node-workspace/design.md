## Context

`release-please-config.json` currently runs four components in manifest mode with `separate-pull-requests: true` and NO grouping plugin: `server` (`apps/server`), `plugin-shared` (`apps/plugin`, excluding `.opencode-plugin` + `.hermes-plugin`, owning shared assets **plus** the Claude/Codex surfaces via `extra-files`), `opencode-plugin`, `hermes-plugin`. This is the 2026-06-14 `collapse-plugin-release-components` state — it auto-tags correctly but couples Claude and Codex into one lock-step component.

The collapse was forced by [release-please#1946](https://github.com/googleapis/release-please/issues/1946): the `linked-versions` plugin hardcodes the grouped release-PR title (`chore${scope}: release <group> libraries`) with no `${version}`, so a merged grouped PR can't be parsed back to a version → never auto-tagged → the next run aborts with "untagged, merged release PRs outstanding". Confirmed against the plugin source; `group-pull-request-title-pattern` only supports `${scope}/${component}/${branch}`, never `${version}` — so no config fixes the grouped title.

What the collapse never evaluated: the **`node-workspace` plugin**. It builds a dependency graph from the `package.json` files of the configured packages and, when a dependency is bumped, patch-bumps each dependent, writes its CHANGELOG, and updates its dependency reference — keeping **independent** versions. Crucially, with `separate-pull-requests: true` and the plugin's own `merge: false`, it produces a **separate, version-titled PR per package** (fixed in [release-please#2310](https://github.com/googleapis/release-please/pull/2310)), so it never reintroduces a grouped/version-less PR.

Version carriers today: `apps/plugin/package.json` (`@rembric/plugin`, 0.11.1 → 0.12.0 after the collapse landed), `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` (currently `extra-files` of `plugin-shared`), `.opencode-plugin/plugin.ts`, `.hermes-plugin/plugin.yaml`. Frozen tag lines `claude-code-plugin-v*` (…v0.11.1) and `codex-plugin-v*` (…v0.11.1) exist in history and will be resumed.

## Goals / Non-Goals

**Goals:**

- Give `claude-code-plugin` and `codex-plugin` independent versions, tags, and CHANGELOGs again — a Claude-only change bumps only Claude.
- Preserve the mandatory cascade: a shared-asset (`@rembric/plugin`) change MUST still bump both clients (they bundle the marketplace-cached bridge), now as an automatic `+patch` via `node-workspace`.
- Guarantee the auto-tag-on-merge property with the same strength as the collapse — every release PR carries `${version}` and tags natively; the #1946 failure mode stays structurally impossible.
- Touch neither the pnpm workspace nor the lockfile: the new client `package.json`s are release-please graph nodes only, not installable workspace members.
- Realign spec + config + `CLAUDE.md` to one true model and supersede the collapse change.

**Non-Goals:**

- Changing any plugin runtime behavior, bridge, hooks, MCP config, or installer flow beyond `component_key()` and the test version map.
- Touching `server`, `opencode-plugin`, or `hermes-plugin` release config (they are not in the dependency graph).
- Publishing any `@rembric/plugin*` package to npm — all stay `private: true`.
- Equalizing client versions. Divergence between Claude, Codex, and `plugin-shared` is the intended outcome.

## Decisions

**1. Use `node-workspace` with `merge: false`, not `linked-versions`, for the cascade.**
node-workspace cascades shared→client bumps while keeping independent versions; `linked-versions` forces same-version AND triggers the #1946 grouped-title bug. `merge: false` is the load-bearing flag: it stops node-workspace from combining the dependent release PRs, so with `separate-pull-requests: true` each touched package gets its own version-titled PR that auto-tags ([#2310](https://github.com/googleapis/release-please/pull/2310)). Alternative considered: keep the collapse (status quo) — rejected because the lock-step misnomer is exactly the complaint; the cost of node-workspace is one dry-run validation, not ongoing fragility.

**2. Claude/Codex become `release-type: node` components with a minimal `package.json` declaring `@rembric/plugin` as a dependency.** node-workspace only sees nodes that have a `package.json` with a dependency edge to the shared package. The client `package.json` is `{ private: true, name: "@rembric/plugin-claude-code" (resp. -codex), version, dependencies: { "@rembric/plugin": <range> } }`. `plugin.json` becomes an `extra-files` updater of the client's OWN component (so both files stay in sync per client). Alternative considered: keep `release-type: simple` with a hand-maintained dep list — rejected; node-workspace is documented around node `package.json` graphs and `simple` would not register a dependency edge.

**3. The client dirs are NOT pnpm workspace members.** `pnpm-workspace.yaml` globs `apps/*` and `packages/*` — single-level, so `apps/plugin/.claude-plugin` is not matched. Adding a `package.json` there does not enlist it; `pnpm install` and the lockfile are untouched. This sidesteps the npm-security posture (allowBuilds, ignore-scripts) entirely — there is no new installable package. The dependency range to `@rembric/plugin` is therefore cosmetic-for-pnpm but functional-for-release-please; the exact form (`workspace:*` vs `*` vs the current `0.12.0`) is settled by the dry-run (Decision 6 / Risk 2).

**4. Revert `plugin-shared` to shared-only.** Re-add all four client dirs to its `exclude-paths`; drop its two `extra-files`. It once again means literally "the shared assets" — name no longer a misnomer. `@rembric/plugin` stays the dependency target of the two clients.

**5. Seed the two new manifest entries at the current shared version (`0.11.1`/`0.12.0` as live at landing).** release-please needs a manifest baseline per component. Seeding at the shared version (and reusing the frozen `claude-code-plugin-v*` / `codex-plugin-v*` tag lines as anchors where they help) keeps the first cascade's diff base stable. The frozen tags ended at `…v0.11.1`; the manifest seed and the first computed bump are verified in the dry-run.

**6. Gate the live cutover on a `release-please --dry-run` (or inspected `workflow_dispatch`) BEFORE merging.** This is the same discipline that de-risked the collapse. The dry-run must confirm: (a) node-workspace resolves the `@rembric/plugin` → claude/codex edges even though the clients aren't pnpm members; (b) a shared-asset commit yields TWO separate PRs (claude, codex) each `+patch` with `${version}` in the title; (c) a Claude-only commit yields ONLY a claude PR; (d) no grouped/version-less PR appears. If (a) fails, fall back to making the clients real `packages/*` workspace members (larger blast radius — flagged as the rollback-of-approach, not the default).

**7. opencode/hermes stay out of the graph via `release-type: simple`.** DRY-RUN FINDING: node-workspace's `buildAllPackages` reads a `package.json` for EVERY `node`-type component to build the graph, and aborts with `FileNotFoundError` if one is missing. opencode is currently `release-type: node` but has no `package.json` (version lives in the `plugin.ts` comment), so it MUST switch to `release-type: simple` (matching hermes) — `simple` packages are not processed by node-workspace at all. This is the one config change beyond the four target packages. Functionally `simple` is also more correct for opencode (its version already lives in the manifest + a generic `extra-files` updater, not a `package.json`).

**8. Anchor-tag seeding (DRY-RUN FINDING).** Seeding the client manifest entries at the current version (0.12.0) without a matching `claude-code-plugin-v0.12.0` / `codex-plugin-v0.12.0` tag made release-please re-scan pre-migration history and compute `0.13.0` (a minor, from the stale `feat!` monorepo restructure) instead of the intended `+patch`. The cascade itself was correct (`@rembric/plugin` 0.12.0→0.12.1, dependency reference updated in both client PRs), but the client bump magnitude was inflated. Mitigation: at migration time, create `claude-code-plugin-v<seed>` and `codex-plugin-v<seed>` anchor tags at HEAD so the first cascade counts only post-anchor commits. The frozen `…-v0.11.1` tags can't anchor because client-dir commits exist between them and HEAD.

## Dry-run outcome (2026-06-14, throwaway branch, torn down)

All three primary gates PASSED against the real repo via `release-please release-pr --dry-run`:

- **Graph resolves despite clients not being pnpm members** — both client PRs show `@rembric/plugin bumped to 0.12.1`. `pnpm-workspace.yaml` globs (`apps/*`, `packages/*`) do not match nested dirs; a clean `pnpm install --lockfile-only` left `pnpm-lock.yaml` byte-identical (the first run's "lock changed" warning was a spurious pnpm reformat, not reproduced).
- **Separate version-titled PRs, no combined PR** — three PRs: `release plugin-shared 0.12.1`, `release claude-code-plugin 0.13.0`, `release codex-plugin 0.13.0`, each on its own `release-please--…--components--<name>` branch.
- **Auto-taggable** — every title carries `${version}`; the #1946 grouped-title failure mode does not occur.

Two findings folded into Decisions 7 and 8 (opencode → `simple`; anchor-tag seeding). The `workspace:*` dependency range resolved correctly — no further range experimentation needed.

## Risks / Trade-offs

- [node-workspace may not resolve a dependency to a package absent from the pnpm workspace] → RESOLVED by dry-run: it resolves by `package.json` `name` read from the configured path; the cascade fired (`@rembric/plugin bumped to 0.12.1` in both client PRs) with the clients outside the pnpm workspace and the lockfile untouched.
- [A `node`-type component without a `package.json` aborts node-workspace] → RESOLVED: opencode moves to `release-type: simple` (Decision 7). Guard: any future `node` component MUST ship a `package.json`.
- [First cascade inflates the client bump by re-scanning pre-migration history] → Mitigation: anchor-tag seeding (Decision 8) — create `claude-code-plugin-v<seed>` / `codex-plugin-v<seed>` at HEAD before the first real run.
- [`merge: false` not honored, producing a combined PR that can't auto-tag — the #1946 regression] → RESOLVED by dry-run: three separate version-titled PRs were produced; #2310 fixed exactly this combination.
- [Trade-off: Claude/Codex versions diverge from each other and from `plugin-shared`] → Accepted because independent versioning is the explicit goal; the installer reads each client's own `plugin.json` version, so divergence is correct, not a bug. The "suite version" concept is intentionally retired.
- [The new client `package.json`s accidentally get picked up by a future widened workspace glob, pulling them into `pnpm install`] → Mitigation: an existing-or-added invariant note in `CLAUDE.md` records that `.claude-plugin`/`.codex-plugin` `package.json`s are release-graph-only; the dry-run/`pnpm install` no-op check in tasks guards the current glob.
- [Cascade is `+patch` only, so a shared `feat:`/breaking change does not propagate its bump magnitude to clients] → Accepted: clients bundle a refreshed copy regardless of magnitude; what matters is that the version moves so the marketplace cache invalidates. `always-link-local` (breaking cascade) is left default; revisit only if a shared major ever needs to force a client major.
- [Resuming `claude-code-plugin-v*`/`codex-plugin-v*` tag lines collides with frozen history] → Mitigation: the frozen tags ended at `…v0.11.1`; seeding the manifest at ≥ that and letting the first cascade compute the next bump means new tags are strictly greater, never colliding. Verified in the dry-run.

## Migration Plan

1. Edit `release-please-config.json` (+ manifest), add the two client `package.json`s, re-create the two client CHANGELOGs (or let release-please create them), update `install.sh` `component_key()` + `install.test.ts`, rewrite the `CLAUDE.md` section + skill, write the spec deltas.
2. Run `pnpm install` and assert `pnpm-lock.yaml` is byte-identical (no new member). Run `pnpm run e2e:installer`, `lint`, `typecheck`, `pnpm test`.
3. Land via PR. After merge, **dry-run / inspect** the release-please run against the gates in Decision 6 before merging any resulting release PR.
4. Merge the cascaded PRs → confirm `claude-code-plugin-vX.Y.Z` and `codex-plugin-vX.Y.Z` tags + releases are created automatically (no manual `gh release create`).

Rollback: revert the config/manifest/`package.json` commit; the prior four-component collapse config is restored from git. No data touched, no published artifact affected.

## Open Questions

- Dependency range form for the client `package.json` (`workspace:*` vs `*` vs pinned) — settled by the first dry-run diff (Decision 3 / Risk 2). Not blocking the proposal.
