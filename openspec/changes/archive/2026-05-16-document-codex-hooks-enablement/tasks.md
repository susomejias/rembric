## 1. docs/agents.md Codex section

- [x] 1.1 Open `docs/agents.md` and locate the Codex section ("Codex CLI (recommended: bundled plugin)" up through "Codex CLI (manual config.toml, no plugin)"). Find the spot right after the "Credentials — REQUIRED: shell env vars" subsection and right before "Using both Claude Code and Codex on the same machine".
- [x] 1.2 Add a new subsection titled `#### Enable plugin_hooks and trust hooks (REQUIRED)`. Body:
  - Open with a 1-2 sentence framing: "MCP works after install + env exports. For lifecycle hooks (session creation, summary-on-compact, end-on-stop) to fire under Codex, two extra steps are mandatory as of codex-cli 0.130.0."
  - **Step 1** (`codex features enable plugin_hooks`): include the literal command, note that the feature is `under development` and default-off in 0.130.0, and that `codex features list` will confirm whether the user actually needs the step in newer Codex releases.
  - **Step 2** (`/hooks` review): inside Codex, open the `/hooks` view, approve each of the 4 hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`). Note that trust persists in `~/.codex/config.toml` `[hooks.state]` so this is a one-time step per hook.
- [x] 1.3 Right below that, add a "Symptom → cause" table with three rows covering the realistic failure modes (no `/dashboard/sessions` rows, "No plugin hooks" in panel, persistent "N hooks need review" banner) and a 4th explicit "out-of-scope" row pointing at the JSON output mismatch (`hook returned invalid session start JSON output`) with a one-line note that it's tracked as a separate change and will be fixed in plugin `0.2.3`.
- [x] 1.4 Confirm the new content reads cleanly with the surrounding "Symptoms of missing envs" bullet list (already in the Codex section) — pick a shared visual style so the two troubleshooting blocks feel sibling, not duplicate.

## 2. plugin/README.md Codex section

- [x] 2.1 Open `plugin/README.md` and find any "Codex" mention in the install/quick-start section. (If the README does not currently have a Codex section, scope is just the docs link in the install section.)
- [x] 2.2 Add a 2-3 line note after the Codex install command: "Codex requires two additional one-time steps for hooks to fire: run `codex features enable plugin_hooks`, then approve hooks via `/hooks` inside Codex. See [docs/agents.md](../docs/agents.md#enable-plugin_hooks-and-trust-hooks-required) for the full walk-through."
- [x] 2.3 Do NOT replicate the full table — README stays brief; link to docs/agents.md for the canonical troubleshooting.
- [x] 2.4 ALSO update the **root** `README.md` "Hooking up Codex CLI" section: same brief note as plugin/README.md, mentioning the `codex features enable plugin_hooks` + `/hooks` review requirement with a link to the anchor in `docs/agents.md`. Caught during review — the root README is the more visible install entry point.

## 3. CLAUDE.md maintainer note

- [x] 3.1 Open `CLAUDE.md` and locate the "Session lifecycle: HTTP, not MCP" subsection under "Plugin development discipline".
- [x] 3.2 Add a maintainer-facing paragraph at the END of that subsection:
  - Records that `plugin_hooks` is `under development` in `codex-cli 0.130.0` with `default_enabled: false`; Codex's `main` branch source (read 2026-05-16) already promotes it to `Stable` / `default_enabled: true`, so the flag will likely move on in a future Codex release.
  - States the symptom of the silent failure: hooks file parses and lives in the cache, but `load_plugin_hooks` is short-circuited by the disabled feature, no log warning is emitted.
  - Notes the diagnostic path for future maintainers: run `codex features list` first when triaging "Codex hooks not firing"; if `plugin_hooks` is `false`, that's the cause.
  - Links to the user-facing doc step in `docs/agents.md`.
- [x] 3.3 Do NOT modify the existing Session lifecycle bullets describing hook env vars, scripts, or session_id handling. The new paragraph is an ADDITION, not a rewrite.

## 4. Spec sync

- [x] 4.1 Confirm `openspec/changes/document-codex-hooks-enablement/specs/codex-distribution/spec.md` contains the MODIFIED `docs/agents.md recommends the plugin install as primary` requirement with three scenarios (primary install path unchanged, new platform-required hook enablement, new symptom-to-cause troubleshooting table, manual fallback preserved unchanged).
- [x] 4.2 Run `openspec validate document-codex-hooks-enablement --strict`. Confirm green.

## 5. Verification

- [x] 5.1 Anchor verification done: `#### Enable plugin_hooks and trust hooks (REQUIRED)` → GitHub slug `#enable-plugin_hooks-and-trust-hooks-required` matches the link target used in `plugin/README.md`. Table renders via standard GFM syntax.
- [x] 5.2 Link target `../docs/agents.md#enable-plugin_hooks-and-trust-hooks-required` matches the actual anchor.
- [x] 5.3 CLAUDE.md paragraph added as the last bullet under "Session lifecycle: HTTP, not MCP" — flows from the existing bullets about hook env vars and session_id handling. Same prose style as the surrounding maintainer notes.

## 6. Commit + push

- [x] 6.1 Commit `f077d2b` — `docs(codex): document plugin_hooks feature flag + /hooks trust review`. Body cites `codex features list` output and the relevant Codex source files (`codex-rs/core/src/session/mod.rs` for the feature gate, `codex-rs/tui/src/startup_hooks_review.rs` for the trust review).
- [ ] 6.2 User confirms intent to push. Then push to `origin/main`.
- [ ] 6.3 Archive this change folder via `/opsx:archive` (syncs the spec delta into `openspec/specs/codex-distribution/spec.md`).
