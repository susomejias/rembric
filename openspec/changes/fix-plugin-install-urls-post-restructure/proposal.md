## Why

The archived change `restructure-monorepo-apps-layout` (2026-05-20) moved the shared plugin tree from `plugin/` to `apps/plugin/` and explicitly mandated — in `openspec/specs/open-source-distribution/spec.md` and `openspec/specs/hermes-agent-plugin/spec.md` — that every install command surface use the new `…/main/apps/plugin/…` URL. Reality drifted: four active files were never updated and continued to ship `…/main/plugin/…` URLs that now return HTTP 404 from `raw.githubusercontent.com`. A user copy-pasting from the per-client README (the surface they actually read at install time) hits the 404 and bounces.

This bugfix realigns those four surfaces with the existing spec **and** adds an invariant test so the same drift cannot recur silently the next time the plugin tree moves.

## What Changes

- **Fix four documented install commands** so each `curl -fsSL …/main/plugin/.X-plugin/install.sh` becomes `…/main/apps/plugin/.X-plugin/install.sh`:
  - `apps/plugin/README.md` — the Hermes + opencode rows of the install table (lines 9–10).
  - `apps/plugin/.hermes-plugin/README.md` — 3 occurrences (primary install, inspect-first, update).
  - `apps/plugin/.opencode-plugin/README.md` — primary install command.
  - `apps/plugin/.hermes-plugin/__init__.py` — module docstring install hint.
- **Add a CI invariant test** at `apps/server/src/test/invariants.test.ts` that fails if any tracked file under `apps/plugin/**`, `docs/**`, `README.md`, or `SECURITY.md` contains the literal substring `raw.githubusercontent.com/susomejias/rembric/main/plugin/` or `github.com/susomejias/rembric/blob/main/plugin/`. The four `openspec/specs/{open-source-distribution,hermes-agent-plugin,opencode-plugin}/spec.md` files are explicitly allow-listed: they document the 404 contract and MUST keep the legacy URL verbatim.
- **Extend `open-source-distribution` spec** with a scenario that names the invariant test as the enforcement mechanism, so future contributors discover the guard from the spec, not by accident.

No client-facing behaviour changes. No server changes. No version bump on any plugin component — release-please will skip these as docs/test-only commits, and the per-client release notes for the next bump can omit them.

## Capabilities

### New Capabilities

(none — bugfix only)

### Modified Capabilities

- `open-source-distribution`: tighten the existing "README plugin install URLs point at apps/plugin" requirement to call out the invariant test as the enforcement mechanism and broaden the scoped surfaces from "README" to "every tracked install-command surface."

## Impact

**Files touched** (4 fix + 1 new test + 1 spec delta):

- `apps/plugin/README.md` (already edited locally, uncommitted)
- `apps/plugin/.hermes-plugin/README.md` (already edited locally, uncommitted)
- `apps/plugin/.opencode-plugin/README.md` (already edited locally, uncommitted)
- `apps/plugin/.hermes-plugin/__init__.py` (already edited locally, uncommitted)
- `apps/server/src/test/invariants.test.ts` — add `legacy plugin install URL substring is absent from non-spec surfaces` test
- `openspec/specs/open-source-distribution/spec.md` — modify the existing requirement (delta), no new requirements

**No impact on**:

- The append-only memory invariant.
- Service-layer scope enforcement.
- `topic_key` convergence.
- Judgment freshness.
- The `/mcp` ↔ `/mcp/<slug>` path-scoping contract.
- Any plugin runtime code path. The Python docstring fix is documentation only — it is never read by `hermes` at runtime.

**Migration**: none — install URLs were already broken; this just stops shipping the broken text. Users with cached/bookmarked `main/plugin/...` URLs continue to receive the same 404 as before; the spec for that 404 contract is unchanged.
