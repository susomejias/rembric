## Context

The root TUI currently runs a Hermes script that copies three files and, on update, repairs two recognized legacy MCP blocks with a backup. Native Hermes supports Git-subdirectory source tracking. The user selected native-isolated: Hermes may manage provider/plugin selection and grants and remove the whole plugin-owned directory; unrelated settings, MCP/bridge pins, credentials and project markers remain protected.

Upstream references supplied by the parent are moving-main source, not execution evidence. `plugins_cmd_install.py` refuses an existing target without force, `plugins_cmd_update.py::cmd_adopt` accepts only self-cloned Git directories, and `plugins_cmd_remove.py` requires an installed target. Native APIs do not make copied installs automatically adoptable or repeated removal automatically successful.

## Goals / Non-Goals

**Goals:** canonical TUI delegation, native source tracking, clear consent and unsupported-case rejection, preserved recognized MCP repair, small tests/docs diff.

**Non-Goals:** a new package/provider/repository, automatic forced migration, local checkout deployment, tag/SHA resolution, pin movement, MCP transport/config refactoring, HTTP tool changes, summary changes, releases or deployment.

## Decisions

1. **Default unpinned source only.** Install uses `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`; update uses `hermes plugins update rembric`; uninstall uses `hermes plugins remove rembric`. Reject explicit `--ref` (including `main`), `REMBRIC_REF`, `REMBRIC_SRC` and `PLUGIN_SRC` for Hermes mutation requests before any mutation. Status remains read-only. Alternatives rejected: ignore the flags, silently resolve tags, clone/copy local trees, or retain the legacy backend.
2. **Copied installs are a refusal, not a migration engine.** Existing untracked, foreign-source, malformed-metadata or linked targets are not overwritten. Explain that the operator must back up the entire existing directory outside Hermes discovery, preserve credentials/MCP settings, move the old directory aside, then invoke the canonical TUI native install. Do not automatically `adopt`, `--force`, move or delete it. Parent accepted this narrow rejection/reinstall contract. Native source metadata must match the canonical Rembric Git URL plus subdirectory before update/removal is treated as managed. Pinned installs are refused with an actionable diagnostic; do not claim a version comparison proves updateability.
3. **Consent is layered.** Root TUI prints commands when Hermes is absent or headless without `--yes`; interactive execution asks confirmation. `--yes` authorizes invocation, not dependency installation, caution bypass, grants or forced replacement. Do not append `--force`/`--yes-deps`. Native failures propagate; no success/restart claim after failure.
4. **Keep only useful wrapper work.** Reuse the existing Hermes scripts as tiny native adapters if needed to retain the recognized legacy MCP repair in one place. Remove file-copy and whitelist-deletion backend logic, not the migration function. Execute repair only after successful native update under existing recognition/backup rules. Fresh install and native-managed unrelated settings stay unchanged by Rembric. Do not broaden recognized config patterns or move bridge pins as part of distribution.
5. **Native ownership is explicit.** Hermes may select/reset `memory.provider`, update plugin selection/grants and remove its complete managed directory. These exceptions replace the old blanket config-preservation/three-file-uninstall promise. Untracked/copied or linked directories remain protected by refusal. If the native target and metadata are both absent, repeated uninstall is a successful no-op; inconsistent state is an error rather than suppressed native failure.
6. **Status does not promise an impossible update.** Keep manifest version detection at `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/plugin.yaml`. Presence means an executable on PATH, not a data directory. Copied, malformed, foreign, pinned or unreadable installs must not recommend/trigger unattended native update. Report unknown with explicit migration/pin guidance; update-all skips them. The measured Hermes v0.22.5 checker also reports drift for freshly native-installed subdirectories because they lack `.git`. Therefore all existing Hermes installations have unknown update status and are skipped by update-all; explicit update validates canonical source metadata. Actual update execution was verified only for an already-current revision. Other clients retain their behavior.
7. **Native packaging owns its subtree.** Native subdirectory installation can ship tests and maintenance scripts; remove the old claim that only three files ship. Do not add a separate packaging mechanism just to exclude tests. Keep the unified release/version carriers unchanged.

## Risks / Trade-offs

- [Risk] `--enable` replaces a different selected provider → Print the native ownership effect before consent; isolate acceptance experiments.
- [Risk] Native removal deletes local state inside its managed directory → Explicitly describe whole-directory removal; refuse legacy/untracked targets and never force replacement.
- [Risk] Upstream YAML rewriting could alter unrelated settings or MCP values → Real-host paired control with synthetic credentials, unrelated config and exact pinned MCP block; compare semantic values and credential bytes, not a false whole-config byte-preservation promise.
- [Trade-off] Local source and custom refs are rejected for Hermes → Accepted to avoid a second backend, pin semantics or hidden network behavior; other clients retain their contracts.
- [Risk] Remote current Rembric contains legacy scripts → Native install must not execute those scripts; verify installed provider and metadata through real CLI.
- [Risk] Official host setup may write globally via prereq installation/product completion → Parent owns setup isolation and helper inspection; worker performs no global/dependency installs.

## Migration Plan

1. Validate artifacts, then prepare a real isolated Hermes host with Python 3.14 and its supported dependency environment. Use scratch HOME/HERMES_HOME/XDG/tool/cache/temp roots and synthetic credentials; no inherited operator configuration.
2. Demonstrate fresh native install/source record/update/remove and repeated-remove failure/control. Seed an old copied target plus unknown files and prove the chosen rejection/reinstall path preserves it. Verify native activation/removal leaves unrelated MCP values and credentials intact. No runtime edits before this evidence.
3. Add focused failing boundary tests, implement the minimal adapter/routing change, then validate headless shared-client regressions and POSIX syntax. Preserve existing MCP migration tests.
4. Update only affected install/distribution docs and skills. Leave release notes to release automation. Keep real acceptance tasks pending unless actually executed.
5. Rollback is operator-controlled restoration of the separately backed-up plugin directory and selection, not a new fallback backend.

## Open Questions

No outstanding policy choice. Isolated acceptance passed on Hermes v0.22.5 (`bf0203a7`): source metadata, config/MCP/credential preservation, copied-install refusal, explicit backup/reinstall and native removal. Actual version advancement and a full gateway/LLM session remain untested; the native checker limitation is reflected in status rather than hidden.
