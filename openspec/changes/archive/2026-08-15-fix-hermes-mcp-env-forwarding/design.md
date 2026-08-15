## Context

The provider loads `${HERMES_HOME}/.env`, but a real Hermes MCP run required explicit `mcp_servers.rembric.env` references. The existing updater only recognizes the legacy `mcp-remote` entry and replaces it with an incomplete npx bridge entry.

## Decision

Use one canonical entry:

```yaml
rembric:
  command: npx
  args: ['-y', '@rembric/mcp-bridge@<plugin-version>']
  env:
    REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}
    REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}
    REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}
  enabled: true
```

On update, replace only:

1. the already-recognized legacy `mcp-remote` block; or
2. the exact incomplete `npx` bridge block previously emitted by the updater.

Keep the existing backup-before-write behavior. Leave every other Rembric block untouched and print the canonical block as the manual fallback. A canonical block is a no-op.

## Risks

Textual YAML recognition can miss formatting variants. That fails safely: the updater preserves the operator-owned config and prints the required block rather than guessing.

## Validation

Use temporary `HERMES_HOME` installer fixtures to prove migration, backup, idempotence, and custom-block preservation. Validate emitted TUI text. The real Hermes MCP run remains the host-level acceptance check.
