## Context

Issue #513 records a 5.5-minute window per plugin release in which clients install a plugin whose exact-pinned `@rembric/mcp-bridge` is not yet on npm. The owner chose to serve plugins from a ref that CI advances only after `publish-npm` succeeds. Rejected options: reordering the publish steps (narrows the window, does not close it) and a bridge fallback (defeats the exact pin).

Facts measured in a sandbox on 2026-11-22, which this design relies on:

1. Codex CLI 0.163.0 never reads `.codex-plugin/marketplace.json`. It reads `.claude-plugin/marketplace.json`, also `.agents/plugins/marketplace.json` and `.cursor-plugin/marketplace.json`. So today Codex follows `main` through the Claude manifest's relative path.
2. Claude Code: switching a relative-path entry to `git-subdir` + `ref` migrates in place after `claude plugin marketplace update` + `claude plugin update`. The plugin stays enabled, `pluginConfigs` options are kept, and `claude plugin update` re-fetches a moving branch ref, both forward and on rollback. Keychain-token preservation is inferred, not measured.
3. Codex: the installer's existing `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric` picks up a moved ref; no `marketplace remove` is needed.
4. Hermes: `hermes plugins install --ref` accepts only a full 40-character commit SHA. A SHA-pinned install refuses `hermes plugins update`, and the pin moves with `hermes plugins install --force --ref <sha>`, which keeps the user's state. A `tree/<branch>` URL silently drops the branch. Install metadata records `{"pinned": true, "revision": <sha>, "source": <canonical source>}`.
5. raw.githubusercontent branch URLs are cached for 300 s; SHA URLs cannot be stale. Unauthenticated `git ls-remote https://github.com/susomejias/rembric.git refs/heads/plugin-release` takes about 0.5 s with no rate limit.
6. No GitHub documentation says `GITHUB_TOKEN` can bypass a ruleset.

## Goals / Non-Goals

**Goals:**

- No client and no TUI "update available" names a plugin version whose bridge is not yet on npm.
- Existing installs migrate without an uninstall.
- Rollback is moving the ref.
- Server installs and upgrades are unchanged.

**Non-Goals:**

- Changing Pi. It installs `@rembric/pi` from npm and never launches the bridge.
- Changing where the root shim fetches the orchestrator. `install.sh` itself stays on `main`, because it is distribution tooling and must already know about the split.
- Changing Hermes update-status reporting. It stays `unknown`.

## Decisions

### D1. One release ref, `plugin-release`, moved only by CI

A job `promote-plugin-release` runs with `needs: [release-please, publish-npm]`:

- **Automatic path:** `plugin_release_created == 'true'` and `publish-npm` succeeded. Target: the new `plugin-v*` tag (a new `plugin_tag_name` output). The update is a fast-forward (`force=false`).
- **Dispatch path:** a new `workflow_dispatch` input `plugin_release_tag`. It promotes, or rolls back to, any `plugin-v*` tag, so this update is forced (rollback is a non-fast-forward).

Both paths run the same three steps:

1. Resolve the tag to its commit.
2. Read `apps/plugin/mcp-bridge/package.json` at that commit and confirm the registry serves exactly that version. This guard holds the issue's invariant on rollback and re-promotion too, not only after `publish-npm`.
3. Compare with the current branch head. When they are equal the job ends without minting a token, which makes reruns no-ops.

The update uses `PATCH /git/refs/heads/plugin-release` through `gh api` instead of a git push. That needs no checkout and makes force explicit per path.

Alternatives considered: a git push with `contents: write` on `GITHUB_TOKEN` — rejected, because no documented mechanism lets that token bypass a ruleset (fact 6). A tag-based ref (`plugin-latest`) — rejected, because Claude's `ref` re-fetch was measured on a branch.

### D2. A GitHub App token is the only writer; `GITHUB_TOKEN` stays read-only

`actions/create-github-app-token` is pinned by full commit SHA (v3.3.0, `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`). The other workflows pin by major tag; this job holds the only credential that bypasses a ruleset, so it gets the stricter pin. Its inputs are `client-id: ${{ vars.PLUGIN_RELEASE_APP_CLIENT_ID }}` and `private-key: ${{ secrets.PLUGIN_RELEASE_APP_PRIVATE_KEY }}`. v3 deprecates `app-id` in favour of `client-id`, hence the variable name. The token is scoped to this repository and `permission-contents: write`. The job itself declares `permissions: contents: read`: the issue asked for `contents: write` on this job only, but the write goes through the App token, so the job needs no write grant at all. The job queues in its own concurrency group, like the publish jobs.

### D3. Claude's manifest is the fix for both marketplace clients

`.claude-plugin/marketplace.json` becomes `{"source": "git-subdir", "url": "https://github.com/susomejias/rembric.git", "path": "apps/plugin", "ref": "plugin-release"}`. Codex reads this file (fact 1), so it fixes Codex as well. `.codex-plugin/marketplace.json` still gets `ref: plugin-release`, because the `codex-distribution` spec defines that file and it costs nothing to keep consistent. No code or test reads it, but deleting it would be a separate change to that spec.

The published `claude-code-plugin` spec states the relative-path source in its unnumbered "Marketplace declaration" section, outside any `### Requirement:` block, so a delta cannot modify it. This change ADDs a requirement that supersedes that bullet. Archiving should edit the bullet by hand in the same commit.

### D4. The installer splits its default ref by track and fetches plugins by commit

- `SERVER_REF` defaults to `main`; `PLUGIN_REF` defaults to `plugin-release`. An explicit `--ref` or non-empty `REMBRIC_REF` sets both.
- `fetch` derives the track from the repository-relative path: `apps/plugin/*` and `.release-please-manifest.json` are plugin artifacts, everything else is a server artifact. A future call site therefore cannot pick the wrong track by forgetting an argument.
- `resolve_plugin_rev` runs at most once per run and only when a plugin artifact is needed, so a server-only run never calls git. A 40-hex `PLUGIN_REF` is used as-is. Otherwise `git ls-remote` asks for the branch and the tag (peeled first, then branch, then tag). The result must be 40 hex characters.
- When git is absent or resolution fails, plugin URLs fall back to the branch name. That only delays an update by the CDN TTL; it never serves an unpublished bridge.
- The opencode child receives the same SHA base URL. The opencode manual-fallback script's own defaults move from `main` to `plugin-release`.

### D5. Hermes pins the resolved commit

Hermes cannot follow a branch (fact 4), so a Hermes install or update is meaningful only with a resolved SHA:

- The TUI refuses a Hermes install/update before any mutation when the SHA cannot be resolved. Hermes itself needs git to clone, so a machine without git cannot install it anyway. Uninstall needs no SHA.
- The TUI passes the SHA to the adapter as `REMBRIC_PLUGIN_REV`. The adapter requires it, as 40 hex characters, for install and update.
- Install runs `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --ref <sha> --enable`. Update runs `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --force --ref <sha>`, which moves the pin and also converts an existing unpinned native install into a pinned one. An install already pinned at that SHA is a no-op on update.
- The adapter's native-state check accepts `pinned` true or false (a JSON boolean) with a 40-hex revision. The legacy-migration path installs with the same `--ref`.
- User-supplied `--ref`, `REMBRIC_REF`, `REMBRIC_SRC` and `PLUGIN_SRC` are still rejected for Hermes. Rollback reaches Hermes by moving `plugin-release`, not by a user ref.

This supersedes three clauses of the unarchived change `use-hermes-native-plugin-manager`: "default unpinned native distribution", update via `hermes plugins update rembric`, and refusing pinned installs. Archive that change first, then rebase this change's Hermes requirement onto the published text.

## Risks / Trade-offs

- **The ref is missing at merge.** Clients would be pointed at a ref that does not exist. Mitigation: the owner creates `plugin-release` at the latest `plugin-v*` tag before merging (owner prerequisite).
- **Bootstrap skew.** Until the first plugin release that contains this change is promoted, the TUI on `main` fetches the old Hermes adapter and opencode script from `plugin-release`. The old Hermes adapter ignores `REMBRIC_PLUGIN_REV` and installs unpinned, as it does today. The old opencode script receives the SHA base explicitly. This change touches `apps/plugin/`, so it triggers that plugin release.
- **Keychain token preservation on the Claude migration is inferred, not measured.** Mitigation: the Claude update note already tells the user to restart; the e2e playbook's real-client layer should confirm it before release.
- **Hermes `install --force --ref` preserving the enabled state** is read from Hermes source, not measured end to end. Same mitigation.
- **The App credential can move the branch arbitrarily.** It is limited to one repository and `contents: write`, it is minted only when a move is needed, and the npm guard refuses any target whose bridge is unpublished.

## Migration Plan

1. Owner: create `plugin-release` at the latest `plugin-v*` tag, then create the App, the variable and secret, and the ruleset.
2. Merge. Claude and Codex users pick up the new source on their next marketplace update; the TUI does it in its update verbs.
3. Rollback: dispatch `release-please.yml` with `plugin_release_tag=plugin-vX.Y.Z`. To revert the whole change, restore the relative path and `main`; the branch can stay.
