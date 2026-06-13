## Why

The TUI installer (`apps/plugin/install.sh`, landed in `add-tui-installer`) was added as an additional entry point, but the documentation still advertises five parallel install paths (manual Docker quickstart; Claude/Codex marketplace commands; opencode/Hermes `curl | sh`), each as a primary instruction in a different place. That is precisely the confusion the TUI exists to remove. We want the docs to present the TUI as the **single, canonical** way to install / set up / upgrade / uninstall, with every per-client command demoted to a clearly-marked "Manual / advanced" fallback. The per-client primitives stay exactly as they are — they are the TUI's backend — only their documentation prominence changes.

## What Changes

- **TUI is the single documented entry point.** Every install/setup/upgrade/uninstall instruction in user-facing docs leads with the TUI one-liner; the manual per-client commands are moved into clearly-labelled "Manual / advanced" sections, never presented as the primary path.
- **Root `install.sh` shim.** A thin repo-root `install.sh` forwards to `apps/plugin/install.sh`, so the canonical URL is `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh` (shorter, memorable — "one point"). It honours the same env/flags by `exec`-ing or sourcing the real script.
- **Docs rewrite** (lead-with-TUI, demote manual):
  - `README.md` — Quickstart leads with the installer; the manual `curl docker-compose.yml + .env + docker compose up` becomes an "Advanced / manual" subsection.
  - `apps/plugin/README.md` — the four-command install table collapses to "install via the TUI"; per-client commands move under "Manual install".
  - `docs/agents.md` — each per-client section leads with the TUI; the marketplace / `curl | sh` commands stay as "Manual config".
  - `apps/plugin/.hermes-plugin/README.md`, `apps/plugin/.opencode-plugin/README.md` — lead with the TUI; keep their `curl | sh` as manual.
- **CLAUDE.md one-liner** — record that install/setup/upgrade is done via the TUI (`apps/plugin/install.sh`) and that any change touching it MUST verify it still works (`install.test.ts` + e2e) before landing.
- **Two new skills** (source at `.agents/skills/`, symlinked into `.claude/skills/`):
  - `rembric-tui-installer` — the installer **contract/reference**: the orchestrator model, the canonical single path, what not to break.
  - `rembric-tui-installer-e2e` — a runnable **e2e validation playbook** to catch installer breakage before deploy (headless vitest suite, POSIX lint, pty-driven interactive smoke, local install round-trips, optional full Docker `up` smoke + teardown). The installer analog of `rembric-smoke-tests`.
- **Headless agent CLI surface.** The installer gains `--status` (+ `--json`) to query detected clients + versions without the TUI, and `--token=<v>` / `--port=<n>` to fully configure a `--server` install non-interactively — so agents/automation drive everything as a CLI. The friendly handling of a `docker compose` container-name conflict (don't clobber an existing install; show an actionable message instead of a raw daemon dump) is included here too.
- **No change to the per-client primitives.** `install.sh`/`uninstall.sh` (opencode, Hermes), `marketplace.json` (Claude, Codex), bridge, and hooks are untouched. They remain the mechanisms the TUI orchestrates and the documented manual fallback.

No load-bearing server invariant (append-only memory, scope-at-service, `topic_key`, judgment freshness) is touched — this is distribution/docs + one shim + one skill.

## Capabilities

### New Capabilities

_None._ (No new behavioural capability — the installer capability already exists; this change sharpens its contract and the docs around it.)

### Modified Capabilities

- `tui-installer`: add a requirement that the TUI is the **canonical, single documented** entry point for install/setup/upgrade/uninstall, and that a repo-root `install.sh` shim exists forwarding to `apps/plugin/install.sh` (canonical URL `.../main/install.sh`).
- `open-source-distribution`: the README's distribution description leads with the TUI installer as the primary path; the manual Docker quickstart is demoted to an advanced fallback (still accurate).
- `codex-distribution`: `docs/agents.md` recommends the **TUI** as the primary install path; the Codex marketplace commands move to a "manual" fallback (still documented).
- `opencode-plugin`: the README leads with the TUI; the existing two-step `curl | sh` install is demoted to "manual".
- `hermes-agent-plugin`: the README leads with the TUI; the existing `curl | sh` curl-installer is demoted to "manual".

## Impact

- **New files**: `install.sh` (repo-root shim); `.agents/skills/rembric-tui-installer/SKILL.md` and `.agents/skills/rembric-tui-installer-e2e/SKILL.md` (each + a `.claude/skills/<name>` symlink).
- **Modified files**: `README.md`, `apps/plugin/README.md`, `docs/agents.md`, `apps/plugin/.hermes-plugin/README.md`, `apps/plugin/.opencode-plugin/README.md`, `CLAUDE.md`.
- **Unchanged (deliberately)**: `apps/plugin/install.sh` behaviour, all per-client `install.sh`/`uninstall.sh`, `marketplace.json` files, the bridge/hooks. Their docs prominence drops; their mechanics do not.
- **Versioning**: the root `install.sh` shim sits outside the four manifest dirs → covered by the `plugin-shared` release-please component (cascades to the `plugin-suite` group), consistent with `apps/plugin/install.sh`.
- **Supply-chain posture**: the root shim is a new `curl | sh` surface; docs MUST keep the download-inspect-run alternative and the tag-pinned `--ref` form. No new npm dependency, no lifecycle script, no `.npmrc` / `pnpm-workspace.yaml` / lockfile change.
- **Skills discipline**: per CLAUDE.md, the new skill MUST be symlinked from `.agents/skills/` into `.claude/skills/` (never authored directly under `.claude/skills/`).
