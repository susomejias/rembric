## Context

The dashboard currently derives administrator access from an empty project selection and write access. Authentication already recognizes `*` as administrator; this change only makes issuance explicit.

## Goals / Non-Goals

- Make administrator issuance deliberate, with Project access as the default and a clear warning for Administrator.
- Preserve global read-only and all single/multiple-project scopes.
- Allow deliberate promotion of existing active tokens without replacing the secret or rewriting history.
- Do not add generic token editing, demotion, roles, schema changes or MCP tools.

## Decisions

- Add `tokenType=projects|admin` to the existing form. Under Project access, write requires a project; read with no projects remains global read-only and is described as non-admin. A third token type was rejected because the existing read selector already expresses that scope.
- Administrator hides project and access controls, submits write access, and explains full read/write access and dashboard administration. No modal: token creation remains non-destructive.
- Validate type, access and conflicting fields in the existing guarded action, before any creation. Reject absent or invalid type, empty project-write, and admin with projects or read access. Keeping implicit defaults or ignoring contradictory fields would preserve accidental grants.
- Use existing components and styles. No new abstractions or dependencies.
- Add a promotion-only row action guarded by the existing admin session and form-specific CSRF. Use the existing danger confirmation because no demotion UI exists; explain that every holder of the current secret gains full administration.
- Keep validation and transaction ownership in TokensService, SQL in TokensRepository. Refuse revoked, expired, deleted, unresolved-project and memberless-set targets. Change only scope/binding and remove current memberships atomically; active administrators are idempotent no-ops. A generic permissions editor or a new token/secret was rejected as unnecessary.
- Reuse current authentication, which reloads grants on cache hits. Prove unchanged-secret behavior through authentication and HTTP checks; leave existing OAuth grants and historical session identities untouched.

### Rotation and one-time delivery

Rotation is separate from promotion. Only an active token may rotate, including administrators; it retains immutable ID, name, grant, membership, expiry and history. Generate a fresh random secret and scrypt hash, then transactionally replace the hash with an expected-hash and active-lifecycle predicate. In the same transaction invalidate all dashboard sessions and OAuth authorization codes/access/refresh credentials whose subject is this token. Roll back every mutation on failure. No environment secret is changed.

Credential-cache entries bind to both token ID and verified hash. Check the current persisted hash on every hit, and re-read the row after asynchronous verification before accepting a cold credential. Tests must include separate service instances and rotation during verification. Subsequent requests with the old secret or descendants fail; already-admitted operations are not cancelled.

The user selected compromise-recovery semantics rather than preserving existing logins/OAuth. Use a dedicated admin/CSRF server action and danger confirmation naming these consequences. Self-rotation returns its secret before any refresh/navigation; closing the result requires login again. Return only necessary secret and public metadata in the action response, retain it only in transient client state, clear on dismissal/unmount, disable duplicate submission while pending. Never use query strings, logs, cookies, browser storage or a reveal endpoint for rotation. Reuse existing components and keep the result outside transient menus. No bulk rotation.

A real browser check demonstrated that Back restores a visible secret through BFCache even though a reload does not. Clear the table-owned result synchronously on `pagehide` before the browser takes its snapshot. Layout-effect activation/cleanup clears retained route state before painting; a table-owned generation rejects action results arriving for an earlier view. A closed view discards the result, not the already-committed rotation; failure guidance requires an explicit retry, never an automatic one.

## Risks / Trade-offs

- [Risk] Crafted submissions could bypass the UI → Validate at the server action boundary, retaining admin and CSRF checks.
- [Trade-off] Old open forms lack the new field → Refuse and ask the operator to reopen the form; no compatibility fallback that mints admin.
- [Risk] Global read-only could be mislabeled administrator → Keep explicit non-admin guidance and scope mapping tests.
- [Risk] Promotion could reactivate an inert or expired credential → Recheck eligibility inside the transaction and condition the UPDATE on live lifecycle state; test refusal without mutation.
- [Risk] Binding cleanup could partially apply → Check the conditional update before membership cleanup and roll back the whole service transaction on failure.

## Migration Plan

Deploy form and action together. Existing tokens are unchanged until explicit promotion or rotation; reverting the implementation needs no database migration. Already-promoted credentials remain administrators and can be revoked through the existing action.
