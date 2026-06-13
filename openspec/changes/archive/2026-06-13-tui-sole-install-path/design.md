## Context

`add-tui-installer` shipped `apps/plugin/install.sh` — a brand-styled orchestrator that prepares the server and installs/updates/uninstalls every client plugin, delegating to each client's real primitive (opencode/Hermes `install.sh`+`uninstall.sh`; Claude/Codex marketplace CLIs). But it was introduced _alongside_ the existing docs, which still present five parallel install paths as primary instructions across `README.md`, `apps/plugin/README.md`, `docs/agents.md`, and two client READMEs. Five specs encode that multi-path documentation as requirements:

- `open-source-distribution` — "README MUST accurately describe the current distribution model".
- `codex-distribution` — "`docs/agents.md` recommends the plugin install as primary".
- `opencode-plugin` — "README documents the two-step install".
- `hermes-agent-plugin` — "Distribution via curl-installer" + "User documentation".
- `tui-installer` — "Supply-chain-safe distribution guidance".

So flipping the docs to lead with the TUI is a spec-level change, not just an edit.

Constraints: the TUI is an orchestrator — the per-client primitives MUST stay (they are its backend, and the documented manual fallback). The repo is strict on single-source-of-truth and supply-chain. `private: true` / npm-CLI sunset are locked.

## Goals / Non-Goals

**Goals:**

- One canonical, user-facing path for install/setup/upgrade/uninstall: the TUI.
- Demote every per-client manual command to a clearly-marked "Manual / advanced" fallback (kept, not deleted).
- A short canonical URL (`.../main/install.sh`) via a root shim.
- A one-line CLAUDE.md rule + a dedicated skill so future changes verify the installer first.

**Non-Goals:**

- Removing or altering any per-client primitive (`install.sh`/`uninstall.sh`, `marketplace.json`), the bridge, or hooks.
- Changing `apps/plugin/install.sh` behaviour (this change is docs + a shim + a skill + spec wording).
- Deleting the manual instructions outright — they remain as the explicit fallback.
- Any server-side behaviour change.

## Decisions

**D1 — Demote manual paths; do not delete them.**
Docs lead with the TUI; the marketplace commands and per-client `curl | sh` move into "Manual / advanced" subsections. Rationale: the primitives are the TUI's backend (for Claude/Codex the TUI literally prints the marketplace commands), and a documented manual fallback is needed for debugging and air-gapped/edge cases. _Alternative:_ delete the manual commands entirely (rejected — loses the fallback and hides the exact commands the TUI runs; higher support burden).

**D2 — Root `install.sh` is a thin shim, not a move.**
A repo-root `install.sh` `exec`s `apps/plugin/install.sh` (resolving its own directory) so every flag/env (`--server`, `--agent`, `--action`, `--up`, `--ref`, `REMBRIC_SRC`, `REMBRIC_NONINTERACTIVE`) passes through unchanged — zero logic duplication. When run via `curl .../main/install.sh | sh` (no local file), the shim instead fetches and runs `apps/plugin/install.sh` from the same ref. _Alternatives:_ move the installer to repo root (rejected — churns release-please ownership; the installer belongs to the plugin tree/`plugin-shared`); keep only the deep URL (rejected — the user wants a memorable single URL).

**D3 — TUI is the canonical entry point in every doc; per-client docs become a "Manual install" appendix.**
`README.md` Quickstart, `apps/plugin/README.md` (the 4-command table collapses), and each `docs/agents.md` per-client section lead with the TUI; the manual command sits below under an explicit heading. _Alternative:_ leave the per-client READMEs as-is (rejected — they are the most-linked-to install docs and the biggest source of the "lío").

**D4 — Two dedicated skills: a contract/reference and an e2e playbook.**
Per the user's choice, the installer gets its own skills rather than a section in `rembric-plugin-development`:

- `rembric-tui-installer` — the **reference**: orchestrator model, canonical single path, what-not-to-break. Maximises visibility of the install-path guard.
- `rembric-tui-installer-e2e` — a **runnable e2e validation playbook** so a contributor/agent can catch installer breakage before deploy.

This mirrors the repo's existing split between `rembric-plugin-development` (reference) and `rembric-smoke-tests` (runnable e2e) — the e2e skill is the installer analog of `rembric-smoke-tests` and cross-links to it for the Docker-stack bring-up. _Alternatives:_ one combined skill (rejected — reference and runnable-procedure have different trigger moments and reading audiences); folding into `rembric-plugin-development` (rejected per user direction; lower visibility).

The e2e playbook is layered by cost/feasibility: **CI-safe** headless layer (vitest `install.test.ts` + `sh -n`), a **local/operator** interactive layer (pty-driven arrow-key smoke via `script`, asserting banner/screen-replace/clean-exit/no-hang), and an **optional full** layer (installer `--up` in a temp dir on an alt port, or `dev:docker:up`, verifying `healthz`/`dashboard` then tearing down). Interactive and full layers are operator-run because a real PTY / Docker isn't available in headless CI.

**D5 — Spec-driven: modify the five distribution specs to flip "primary".**
Each affected requirement is updated so the TUI is the primary documented path and the manual command is the explicit secondary fallback — full updated requirement content (not a diff), per OpenSpec archive-sync rules.

## Risks / Trade-offs

- [Risk] Root shim drifts from `apps/plugin/install.sh` or drops a flag/env → Mitigation: the shim does not reimplement anything; it `exec`s (local) or curls+runs (remote) the real script verbatim, so args/env pass through; an `install.test.ts` case exercises the shim path.
- [Risk] Two `install.sh` files confuse contributors → Mitigation: the root one is a documented ~10-line forwarder with a header comment pointing at the real script; CLAUDE.md + the skill name the canonical implementation.
- [Trade-off] Keeping manual docs (demoted) means the page is longer than a pure single-path doc → Accepted: fallback + debuggability outweigh brevity; the "Manual / advanced" heading keeps the primary path unambiguous.
- [Risk] Spec wording that previously said "primary" now contradicts archived `add-tui-installer` intent → Mitigation: this change explicitly supersedes those requirements with full updated content; `openspec validate --strict` gates it.
- [Trade-off] Root shim is a new `curl | sh` supply-chain surface → Accepted: docs keep the inspect-first two-step and `--ref` pin; no new dependency.

## Migration Plan

Additive + docs. Deploy = land the shim, the skill (+ symlink), the CLAUDE.md line, the doc rewrites, and the spec modifications. Rollback = revert; the per-client primitives and their (now-manual) commands are untouched and still work. No data migration. E2E: `install.test.ts` (extended for the shim) + a manual TUI run; the per-client manual commands remain valid.

## Open Questions

- Should the root shim, when run from a local clone, `exec` the sibling `apps/plugin/install.sh` directly, or always re-resolve via `REMBRIC_SRC`? (Leaning: `exec` the sibling when present, else fetch by ref — mirrors the existing `REMBRIC_SRC` vs remote logic.)
- Do the `.claude-plugin` / `.codex-plugin` dirs need their own README touch-ups, or is `docs/agents.md` + `apps/plugin/README.md` sufficient for those two? (Leaning: docs/agents.md + plugin README suffice; they have no standalone README today.)
