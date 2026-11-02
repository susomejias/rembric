## Why

Creating a token currently grants administrator privileges when the operator leaves Projects empty and keeps the default write access. Administration should be an explicit choice, not a side effect of an empty selection. Operators also need to deliberately promote an existing active credential without replacing its secret.

## What Changes

- Add a token-type choice, Project access or Administrator, defaulting to Project access.
- Explain full server administration and dashboard access when Administrator is selected.
- **BREAKING**: require an explicit token type in dashboard create submissions; Project access with write requires at least one project.
- Preserve all existing scope shapes, including global read-only access, without automatic changes to existing tokens.
- Add confirmed promotion of an existing active token to administrator, preserving its secret and history.
- Label administrator rows with an Admin badge and meaningful reach text.
- Add single-token rotation for active credentials: preserve identity/grants/expiry, replace only the secret hash, invalidate linked dashboard sessions and OAuth codes/access/refresh credentials atomically, and display the new secret once without putting it in URLs or storage.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: make administrator token creation explicit and add confirmed promotion from the token row menu.
- `auth`: define atomic promotion of active static credentials without changing credential identity.

## Impact

- `apps/web/src/components/dashboard/tokens-sheet.tsx`: explicit type selection and contextual guidance.
- `apps/web/src/app/dashboard/tokens/page.tsx`: validate the type before minting a token.
- Token form and action tests cover safe defaults, positive mappings and refused combinations.
- `apps/web/src/components/dashboard/tokens-table.tsx`: confirmed row action for active non-admin tokens.
- `packages/core/src/services/tokens.ts` and `packages/db/src/repositories/tokens-repository.ts`: transactional grant normalization; authentication keeps using the current persisted grant.
- Dashboard-session and OAuth repositories: invalidate descendants by token identity during rotation.
- No new dependencies, migrations, roles, MCP tools or changes to memory service-layer scope enforcement.
