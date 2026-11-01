## Context

Revoked credentials remain visible. Tokens anchor project memberships and session provenance; physical deletion would damage history.

## Goals / Non-Goals

Goals: let administrators remove revoked tokens after explicit confirmation, without restoring access or losing history.

Non-goals: deleting active or expired-but-unrevoked credentials, bulk deletion, restore, purge, new MCP tools, OAuth grant cascades.

## Decisions

- Add nullable `tokens.deleted_at` using a generated Drizzle migration. Prefer tombstones over physical deletion to retain all foreign-key associations.
- `deleteRevoked(id)` validates nonempty ID, existence, and revocation at the service boundary. The repository conditionally updates only revoked, undeleted rows. Repeated deletion returns `token_not_found`; unrevoked deletion returns `invalid_input`.
- Filter tombstones only from the service listing. Keep repository historical reads, authentication reads, names and bootstrap counts unchanged. Unlike filtering every read, this preserves existing revocation errors and prevents credential/name resurrection.
- Dashboard session resolution joins only undeleted tokens. Prefer this single read gate over deleting each cookie row; all linked cookies become invalid while historical rows remain.
- Use the existing guarded server-action pattern and `ConfirmSubmit` danger dialog. Only revoked rows expose Delete. Cancel never submits. Prefer existing components over a new confirmation mechanism.

## Risks / Trade-offs

[Trade-off] Tombstones retain credential hashes and names → Accepted because preserving provenance and preventing name reuse are explicit requirements.

[Risk] Cached bearer verification could bypass lifecycle state → Existing authentication re-reads rows on every request; test warm and cold rejection.

[Risk] A crafted form targets an active token → Service validation and conditional repository update independently refuse it; test both boundaries.

## Migration Plan

Deploy the generated additive nullable-column migration before the new application reads. Existing rows remain visible with null deletion timestamps. Roll back application code without dropping the column or erasing tombstones; older code will display those revoked rows again, but bearer revocation remains intact.

## Open Questions

None.
