## Context

The previous two changes (`2026-05-16-fix-codex-mcp-env` and `2026-05-16-fix-codex-bridge-path-scoping`) shipped the structural Codex install: MCP server registered, bridge spawns with the right cwd, credentials forward correctly, path-scoping pins the project. End-to-end MCP works. But the verification step surfaced two **non-code** failures that prevent the Codex experience from being equivalent to Claude Code:

1. `codex features list` reports `plugin_hooks  under development  false`. Codex 0.130.0 ships this feature OFF by default. Plugin hooks load only inside `if plugin_hooks_enabled { ... }` in `codex-rs/core/src/session/mod.rs`. With the flag off, hooks are not loaded, not warned about, not anywhere visible — they just don't exist for the session.
2. Even once enabled, `codex-rs/tui/src/startup_hooks_review.rs` enforces a trust review for every plugin hook. `HookMetadata.trustStatus` is `Untrusted` by default. Codex surfaces a startup banner ("N hooks need review") but the user has to open `/hooks` and explicitly approve each handler before they fire.

Both gates are enforced by Codex, not by our plugin. We cannot pre-set the feature flag or pre-trust the hooks at install time — the install path runs in a sandboxed context with no write access to `~/.codex/config.toml`. The only thing the plugin author can do is document the user-side steps clearly. That's this change.

Out-of-scope code work (already triaged during exploration):

- **Hook output schema mismatch.** Once `plugin_hooks=true` and hooks are trusted, they execute — and immediately fail because their stdout is plain text. Codex requires JSON per `codex-rs/hooks/src/engine/output_parser.rs::parse_session_start` and the related per-event parsers. Fix shape: scripts emit `{"hookSpecificOutput":{"additionalContext":"..."}}`. Separate change.
- **Plugin skills.** Currently `/plugins` shows "No plugin skills" because Rembric intentionally ships none. Token-budget decision deferred to its own change.

## Goals / Non-Goals

**Goals:**

- A new Codex user reading `docs/agents.md` end-to-end can go from zero to working hooks (sessions visible in `/dashboard/sessions`) without trial-and-error.
- A maintainer investigating a "hooks broken under Codex" regression in the future starts at the right hypothesis (`codex features list`) instead of grepping the script source. `CLAUDE.md` records the gotcha.
- The `codex-distribution` spec captures the platform requirement so it shows up in any future audit of the install flow.
- Zero changes to `plugin/` — no version bump, no marketplace re-clone, no `/plugin install` redo for existing users. Pure repo-level docs and openspec spec deltas.

**Non-Goals:**

- Implementing the JSON hook-output fix. That's a separate change with its own implementation, spec delta, and version bump.
- Changing the documented hook output shape in the existing `claude-code-plugin` spec. Those scripts still emit plain stdout (works for Claude Code today). Codex compatibility is the next change.
- Adding skills. Out of scope of this proposal; tracked under separate consideration.
- Auto-enabling the feature for the user from the install script. We could in theory check `codex features list` and patch `~/.codex/config.toml` from a post-install hook — but post-install hooks would require the same `plugin_hooks=true` to run reliably, and silently mutating user config is bad form.

## Decisions

### 1. Three doc surfaces, not one

**Decision.** Update `docs/agents.md` (full troubleshooting), `plugin/README.md` (brief, links to docs), `CLAUDE.md` (maintainer note). Three places, three audiences.

**Why three.** Each entry point hits a different reader:

- `docs/agents.md` Codex section: the user reaching the canonical install doc. They expect a complete walk-through. Add a new "Enable plugin_hooks and review hooks" subsection right after the env-var snippets and before the "Updating the plugin" subsection. Include the symptom → cause table so users who skipped the prose can still self-diagnose from the visible failure mode.
- `plugin/README.md` Codex section: the user landing on the GitHub repo or post-`plugin install`. They need the headline ("you must also run `codex features enable plugin_hooks`") and a link to docs/agents.md. Brief.
- `CLAUDE.md` Session lifecycle subsection: future maintainers (us, or contributors). They need to know the feature flag is a known footgun in Codex 0.130.0 and that Codex's `main` branch already promoted it to stable. So when a contributor in 6 months sees the `under development` warning disappear in some new Codex release, they understand the history.

**Alternatives considered:**

- **One doc surface only.** Rejected — too easy to miss. Users who read README never see docs/agents.md, and vice versa.
- **A standalone `docs/codex-troubleshooting.md`.** Rejected — fragments the install story across two files. `docs/agents.md` is already the canonical agent integration doc; adding to it keeps the reader path linear.

### 2. Symptom-vs-cause table format

**Decision.** Include a small "If you see X, the cause is Y" table in `docs/agents.md`. Two rows:

| Symptom                                                          | Cause                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/dashboard/sessions` stays empty                                | `plugin_hooks` feature is off OR hooks haven't been trusted via `/hooks` |
| `/plugins` panel shows "No plugin hooks"                         | `plugin_hooks` feature is off                                            |
| Startup banner "N hooks need review" persists across launches    | Hooks need `/hooks` review and per-hook approval                         |
| `hook returned invalid session start JSON output` error in Codex | Separate follow-up change (out of scope here)                            |

**Why a table.** Users typically open docs after hitting a symptom, not before. Lead with what they see; explain what to do. Matches the existing structure of the "Symptoms of missing envs" bullets in `docs/agents.md`.

### 3. No spec delta for `claude-code-plugin`

**Decision.** Spec delta touches only `codex-distribution`. The `claude-code-plugin` spec stays as-is because:

- Claude Code does not have a `plugin_hooks` feature flag (Claude Code's hook engine is always on).
- Claude Code has no `/hooks` trust review for plugin-bundled hooks.
- The user-facing onboarding step the `claude-code-plugin` spec specifies (`claude plugin install rembric@rembric` + keychain prompt) does NOT require an extra enablement command.

`CLAUDE.md` mentions Claude Code in the maintainer note for contrast, but that's prose, not a spec requirement.

### 4. No version bump

**Decision.** No `plugin/.{claude,codex}-plugin/plugin.json:version` bump. No `plugin/CHANGELOG.md` entry.

**Why not.** Per the CLAUDE.md rule:

> _"any time you change something in `plugin/` that users need to see (scripts, hooks, mcp.json, bin/, manifests themselves), bump BOTH manifest versions in the same commit."_

This change touches **no files under `plugin/`** — only repo-root docs (`docs/agents.md`, `plugin/README.md` lives inside `plugin/` though — wait, that one IS under `plugin/`). Let me reconsider.

`plugin/README.md` is technically inside `plugin/`. But:

- It's not a "scripts, hooks, mcp.json, bin/, manifests" item.
- A README change doesn't invalidate any cached behaviour — users read it from GitHub or after `plugin install`, but its content has zero runtime effect.
- The "users need to see [it]" clause is about cache invalidation: if we don't bump, users keep running the old behaviour. A README-only change has no behaviour to keep.

**Decision: skip the version bump for this change.** Conservative interpretation says bump anyway; pragmatic interpretation says don't. Pragmatic wins because the cost of an unnecessary cache invalidation (forcing every Codex user to re-pull a no-op update) outweighs the readability win.

If the next change (the JSON hook-output fix) bumps to `0.2.3`, the README will roll forward with it via that bump.

## Risks / Trade-offs

**[Codex stabilises `plugin_hooks` to default-on in a near-future release]** → our docs would become misleading ("you need to run `codex features enable plugin_hooks`" when the user actually doesn't).
Mitigation: include a forward-looking note in `docs/agents.md`: _"As of `codex-cli 0.130.0`, this feature is required. Newer Codex versions may default it on — check `codex features list` first to confirm."_ `CLAUDE.md`'s maintainer note already records that Codex `main` has it labelled stable.

**[A new user enables `plugin_hooks` but then can't find `/hooks` in the TUI]** → the trust review only surfaces if hooks need review at startup, AND only on specific TUI views. If the banner is dismissed or missed, the user has no obvious way to retrigger.
Mitigation: docs say to relaunch Codex if the trust review banner does not appear after enablement. Worst case, the user uninstalls and reinstalls the plugin to force a fresh hook-discovery cycle.

**[User pastes the `codex features enable plugin_hooks` command outside their shell with `codex` on PATH]** — copy-paste failure mode.
Mitigation: docs preface the command with the standard "in the shell that launches codex" wording (already used elsewhere in `docs/agents.md`).

**[Spec delta drift]** — the symptom-vs-cause table in `docs/agents.md` could fall out of sync with the spec scenarios as we add the next change (JSON hook output).
Mitigation: docs explicitly note "as of plugin 0.2.2"; the next change will replace the obsolete row of the table.

## Migration Plan

This is a docs-only change. No migration. After merging:

1. Existing Codex users who already hit the symptom can read `docs/agents.md` and follow the two enablement steps. No reinstall required — `codex features enable plugin_hooks` mutates `~/.codex/config.toml`; `/hooks` review mutates `~/.codex/config.toml`'s `[hooks.state]`. Next `codex` restart picks both up.
2. New Codex users read the updated docs as part of their initial install flow.
3. Maintainers reference `CLAUDE.md` when triaging future "hooks broken under Codex" reports.

No rollback needed; docs reversion is a single revert commit.

## Open Questions

- **Does Codex's `main` branch (which already labels `plugin_hooks` as stable) ship a new CLI version any time soon?** If yes, we may want to time this docs change with that release: prefix the enablement note with "if you're on `codex-cli ≤ 0.130.0`". Not blocking — we can edit when the new Codex CLI version lands.
- **Is the trust review really required EVERY time after enabling `plugin_hooks`, or only on first encounter?** Empirically (this session) the user saw the banner once after enabling and then approved all four hooks. Subsequent launches don't re-prompt — trust persists in `hooks.state`. Docs should note this so users don't expect a re-prompt loop.
- **Are there any future changes coming to Codex's hooks subsystem we should warn about?** Worth a peek at openai/codex's roadmap before this change archives. Low priority; if such changes land, they get their own docs update.
