## Why

CI run38160543939 reproduced three dangling MCP requirement citations after the batch archive and rejected the complete38-file migration inventory against a stale37-file Docker gate. Local strict spec validation and application tests did not execute those repository-level delivery checks.

## What Changes

- Retarget the three requirement citations to the published batch annotation requirement, without changing their contracts.
- Update Docker and both CI boot-smoke counts to38, preserving exact completeness checks.
- Execute all three shell count guards against the source inventory and missing/extra controls in one regression test.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: correct citations in the research-tools, entity-projection and description/response requirements.

## Impact

`openspec/specs/mcp-api/spec.md`, `apps/web/Dockerfile`, `.github/workflows/ci.yml` and `apps/web/src/test/docker-migrations.test.ts`. No dependency, installation permission, migration SQL, MCP behavior or durable invariant changes.
