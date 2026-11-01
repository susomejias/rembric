## 1. Contract and isolated acceptance gate

- [x] 1.1 Record approved native-isolated ownership, default-source-only support and copied-install rejection/reinstall decisions in proposal, design and two capability deltas.
- [x] 1.2 Validate artifacts with `openspec validate use-hermes-native-plugin-manager --strict` and consume exact `openspec instructions apply --change use-hermes-native-plugin-manager --json` context before runtime work.
- [x] 1.3 PARENT-OWNED: prepare a real isolated Hermes runtime without operator configuration, host mounts, real credentials or global host installs; record immutable image/source identity and actual CLI capabilities, not moving-main assumptions.
- [x] 1.4 PARENT-OWNED: execute native subdirectory install with synthetic required settings, inspect source/revision/pin metadata and provider selection, exercise update and remove, and compare unrelated config/MCP values and credential bytes against controls.
- [x] 1.5 PARENT-OWNED: seed a copied install plus unknown local file, observe native install/adopt refusal without force, and verify explicit backup/move-aside/reinstall preserves the backup. Measure repeated native remove and confirm the adapter's absent-state requirement. Stop before runtime edits if evidence contradicts the bounded design.

## 2. Test-first native delegation

- [x] 2.1 Add focused root-installer tests observing printed/executed native install/update/remove argv, binary absence, `--yes`/no-consent and failure propagation; capture intended RED with `cd apps/web && pnpm vitest run --root ../.. ../../install.test.ts`.
- [x] 2.2 Add negative controls for unsupported local/ref overrides before mixed-operation mutation, copied/foreign/pinned/malformed/linked targets, unknown local-file preservation and already-absent versus inconsistent removal.
- [x] 2.3 Replace Hermes file-copy/whitelist-deletion backend with minimal native CLI adapters and root routing; retain only existing recognized legacy MCP repair and backup behavior after successful native update. Focused tests SHALL pass GREEN without changing MCP transport or bridge pins.
- [x] 2.4 Exercise status detection/version paths and update-all skips for unsupported provenance; retain accepted action labels and existing Claude/Codex/opencode/Pi command regressions in the root test suite.
- [x] 2.5 Update the existing Hermes uninstall tests for native ownership and idempotence. Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests -p test_uninstall.py` and preserve legacy MCP recognition/current-config controls in the focused installer suite.

## 3. Documentation and validation

- [x] 3.1 Update only affected root/plugin/Hermes README and `docs/agents.md` distribution sections: canonical TUI first, native manual fallback, explicit unsupported cases, safe operator backup/reinstall, native activation/removal effects; retain complementary pinned MCP wiring and unrelated runtime guidance.
- [x] 3.2 Update installer skill contract and Hermes client gotchas for native distribution without adding package/repository/provider abstractions or hand-written CHANGELOG entries.
- [x] 3.3 Run focused shared-client installer regression suite and POSIX syntax checks: `sh -n install.sh`, `sh -n apps/plugin/install.sh`, `sh -n apps/plugin/.hermes-plugin/install.sh`, `sh -n apps/plugin/.hermes-plugin/uninstall.sh`.
- [x] 3.4 PARENT-OWNED: run local and pty installer layers in isolated state, and real native Hermes install/update/remove acceptance with unchanged MCP settings/credentials. Keep pending any unavailable real-host/provider acceptance; mocks are not e2e evidence.
- [x] 3.5 PARENT-OWNED: weaken each new safety guard separately using `scripts/mutate.mjs`, capture named test failures and byte-verified restoration; writer supplies exact mutations after runtime handoff but does not run backup/deletion operations.
- [x] 3.6 Re-run strict OpenSpec validation, inspect exact diff and report observed RED/GREEN, actual e2e evidence and pending acceptance. Preserve pre-existing summary work and leave staging/commit/push/release/deployment to the parent.
