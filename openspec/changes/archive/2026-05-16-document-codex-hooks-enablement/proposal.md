## Why

In `codex-cli 0.130.0`, the `plugin_hooks` feature is marked as `under development` and **defaults to off** (`codex features list` reports `plugin_hooks  under development  false`). Without it, `load_plugin_hooks` is skipped entirely in `codex-rs/core/src/session/mod.rs` — the plugin's `hooks.codex.json` never loads, and the `/plugins` panel reports "No plugin hooks". Symptom: silent failure. Users install the Rembric plugin under Codex, see MCP work fine, and notice that `/dashboard/sessions` stays empty no matter how many sessions they run. Diagnosed live during the previous change's verification.

Even after enabling `plugin_hooks`, Codex requires each plugin-bundled hook to be trusted via the startup `/hooks` review (`codex-rs/tui/src/startup_hooks_review.rs`). Until trusted, hooks load into the system but do NOT execute — `HookMetadata.trustStatus = Untrusted`. Codex surfaces this as a startup banner: _"4 hooks need review before they can run. Open `/hooks` to review them."_ Users who dismiss that banner or miss it lose hook execution silently.

Both steps are platform-level requirements Rembric cannot satisfy for the user. The plugin install command can't enable user-level features or set hook trust on the user's behalf. Without docs, every new Codex user repeats the same diagnosis loop the maintainer just went through.

## What Changes

- **`docs/agents.md` Codex section** — adds a required subsection _"Enable plugin_hooks and review hooks"_ after the install command and env-var snippets. Lists two concrete steps (`codex features enable plugin_hooks` then `/hooks` inside Codex) and includes a "symptom → cause" troubleshooting table for the common failure modes (no `/dashboard/sessions` rows, "No plugin hooks" in panel, "N hooks need review" banner ignored).
- **`plugin/README.md` Codex section** — shorter version of the enablement note, with a link to `docs/agents.md` for the full troubleshooting story. README is the entry point new users see when they `claude plugin marketplace add ...` or browse the repo on GitHub.
- **`CLAUDE.md` Session lifecycle subsection** — adds a maintainer-facing note that `plugin_hooks` is `under development` in `codex-cli 0.130.0` (subject to change in future releases — Codex's `main` branch source already labels it `stable`/`default_enabled: true`). Notes that the symptom is silent hook absence with zero log warnings, so future maintainers know to check `codex features list` first when investigating "hooks not firing under Codex" regressions.

## Capabilities

### New Capabilities

_(none — documentation update only)_

### Modified Capabilities

- `codex-distribution`: the documentation requirement for the Codex install flow grows by one mandatory step (`codex features enable plugin_hooks`) and one mandatory user action (`/hooks` review). Both are platform-imposed prerequisites for hook execution; today's spec doesn't mention either.
- `claude-code-plugin`: unchanged at the requirement level, but the maintainer-facing note in `CLAUDE.md` references the spec's existing Session lifecycle section. No spec delta needed for `claude-code-plugin`.

## Impact

- **Touched paths**: `docs/agents.md`, `plugin/README.md`, `CLAUDE.md`, and a new spec delta at `openspec/changes/document-codex-hooks-enablement/specs/codex-distribution/spec.md`.
- **Untouched**: every file under `plugin/.claude-plugin/`, `plugin/.codex-plugin/`, `plugin/bin/`, `plugin/scripts/`, `plugin/hooks/`, `plugin/commands/`. No version bump in either manifest (per the CLAUDE.md rule: docs-only changes that don't affect runtime artifacts don't need a version bump — the rule applies to "anything users need to see [in plugin/]"; CLAUDE.md and `docs/agents.md` are repo-root, not plugin-bundled).
- **End-user impact (Codex, new installs)**: explicit two-step enablement that previously had to be reverse-engineered or learned by trial. Faster path from `codex plugin install rembric` to working hook-driven session capture.
- **End-user impact (Codex, existing installs that hit the silent failure)**: the symptom-vs-cause table in `docs/agents.md` lets them self-diagnose without filing an issue.
- **End-user impact (Claude Code)**: zero. Claude Code does not have `plugin_hooks` as a feature flag — its hook engine is always on, no trust review.
- **Maintainer impact**: future investigation of "Codex hooks not firing" starts at the right hypothesis (`codex features list`) instead of at the script content. Saves an hour of code-reading per occurrence.
- **Out-of-scope follow-ups (intentionally tracked here for clarity)**:
  1. _Hook output JSON schema mismatch._ After enabling hooks and approving them, scripts run but Codex rejects their stdout: `error: hook returned invalid session start JSON output`. Codex requires structured JSON (`{ hookSpecificOutput: { additionalContext: "..." } }`) per `codex-rs/hooks/src/engine/output_parser.rs`. Our scripts emit plain text. Fix is a separate change: update `plugin/scripts/*.sh` to emit JSON. Likely needs a `plugin/.claude-plugin/plugin.json` version bump (`0.2.2 → 0.2.3`) and a spec delta on the hook-script invariants.
  2. _Plugin skills._ `/plugins` panel shows "No plugin skills" because Rembric intentionally ships no skills (protocol guidance is delivered via `initialize.instructions`). If we want a visible skill row, the trade-off is token budget vs. duplication with the existing handshake. Separate decision.
