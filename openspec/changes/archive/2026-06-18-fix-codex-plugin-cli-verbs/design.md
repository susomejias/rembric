## Context

The Codex CLI `plugin` command surface (verified live against `codex-cli 0.141.0`):

```
$ codex plugin --help
Commands:
  add          Install a plugin from a configured marketplace snapshot
  list         List plugins available from configured marketplace snapshots
  marketplace  Add, list, upgrade, or remove configured plugin marketplaces
  remove       Remove an installed plugin from local config and cache
```

`codex plugin add --help` documents the selector as `PLUGIN[@MARKETPLACE]` — either `rembric@rembric` or `rembric --marketplace rembric`. The marketplace name `rembric` comes from our `.codex-plugin/marketplace.json` (`name: "rembric"`), which is what `codex plugin marketplace add` registers. This mirrors the Claude Code selector we already use (`rembric@rembric`).

There is no `codex plugin update` / `codex plugin install` / `codex plugin uninstall`. The historical proposal `add-codex-distribution` guessed these verbs from the agentmemory reference and flagged them as unverified; the guess was wrong.

## Goals / Non-Goals

**Goals**

- The TUI installer's Codex install/uninstall/update paths run real Codex CLI commands that succeed.
- Docs, test, and specs quote the same correct commands so they don't drift back.

**Non-Goals**

- No change to the marketplace manifest, the bridge, the hooks, or any per-client primitive.
- No change to the post-install hook-enablement guidance (`codex features enable plugin_hooks`, `/hooks` trust, `REMBRIC_*` export) — that part was already correct.

## Decisions

### Decision 1: install → `codex plugin add rembric@rembric`, uninstall → `codex plugin remove rembric@rembric`

Use the fully-qualified `PLUGIN@MARKETPLACE` selector (`rembric@rembric`) rather than bare `rembric`, matching the Claude Code line and removing any ambiguity if a second marketplace ever defines a `rembric` plugin.

### Decision 2: update = refresh snapshot **then** re-add

`codex plugin marketplace upgrade rembric` only refreshes the Git marketplace _snapshot_; it does not re-install the already-cached plugin from that new snapshot. The Codex CLI exposes no per-plugin update verb. So the installer's update path chains both:

```
codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric
```

`codex plugin add` against an already-installed plugin re-installs from the refreshed snapshot (verified: re-running `add` reports "Added plugin … Installed plugin root: …/<version>"), which is the actual upgrade mechanism. This is the closest correct analogue to Claude Code's single `claude plugin update`.

The installer's `update` action sets `add=''` (no `marketplace add`) before printing — the marketplace is already registered on update, so only the upgrade+re-add chain runs. That existing branch logic is unchanged; only the command string it carries changes.

### Decision 3: keep the no-`install`-verb guard in the test

The update-scenario test keeps `expect(codex.out).not.toContain('codex plugin install')`. Since the corrected verb is `add`, this assertion now doubles as a regression guard against the exact bug being fixed — if anyone reintroduces an `install` verb anywhere in the Codex output, the test fails.

## Risks / Trade-offs

- **`codex plugin add` re-install semantics could change upstream.** Low risk: the `add` verb is the documented install primitive and behaves idempotently today. If a future Codex CLI adds a dedicated `update`, the installer's update string is the single place to change. Mitigation: the e2e installer playbook exercises the printed commands.
- **Marketplace name coupling.** `rembric@rembric` assumes the marketplace registers as `rembric` (it does, per the manifest `name`). If the manifest name ever changes, the selector must change with it — same coupling the Claude Code line already has.

## Migration Plan

None. Users who hit the failed `codex plugin install` simply re-run the installer (or `codex plugin add rembric@rembric`) once the fix ships. No state to migrate; the failed run left only the registered marketplace, which the corrected flow reuses.

## Open Questions

None.
