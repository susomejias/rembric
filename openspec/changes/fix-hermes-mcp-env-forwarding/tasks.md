## 1. Hermes bridge configuration

- [x] 1.1 Extend the conservative Hermes updater to repair the exact incomplete bridge entry with the canonical explicit-env, enabled block while preserving custom entries and backup behavior.
- [x] 1.2 Print the same canonical block from the root installer for Hermes install and update fallback.
- [x] 1.3 Add regression tests for legacy and incomplete-entry migration, canonical idempotence, custom preservation, and TUI output.

## 2. Documentation

- [x] 2.1 Correct Hermes docs to require the explicit MCP `env` map and remove automatic-inheritance claims.
- [x] 2.2 Update the bridge compatibility table to separate supported hosts from recorded host-level verification.

## 3. Validation

- [x] 3.1 Run targeted installer, bridge, format, typecheck, lint, and OpenSpec validation.
- [ ] 3.2 Operator-only: verify the updated bridge config in a real Hermes run against the dev stack with credentials absent from the parent shell.
