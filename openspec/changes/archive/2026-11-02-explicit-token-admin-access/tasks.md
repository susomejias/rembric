## 1. Explicit token creation

- [x] 1.1 Add action-boundary regression tests for explicit admin, project scopes, global read-only, invalid types and conflicting submissions; observe RED before implementation.
- [x] 1.2 Add the default Project access / Administrator choice and warning, with matching server validation; observe GREEN and mutation-check each new guard.

## 2. Existing active tokens

- [x] 2.1 Add regression tests for promotion, lifecycle refusals, unchanged secret/history, membership normalization and rollback; observe RED before implementation.
- [x] 2.2 Implement the service/repository mutation and confirmed dashboard action; observe GREEN and mutation-check each eligibility guard.
- [x] 2.3 Verify reuse of the same credential through warmed authentication, dashboard login and MCP, without changing OAuth grants.

## 3. Verification

- [x] 3.1 Run focused tests, typecheck, lint, independent verification and strict OpenSpec validation; preserve unrelated changes.
- [x] 3.2 Verify creation, promotion and rotation on desktop and narrow screens, including switching types, confirmation/cancel and successful/refused submissions.
- [x] 3.3 Run the production web build after browser verification, without resetting a running development server's output.

## 4. Administrator labels and secure rotation

- [x] 4.1 Replace technical admin scope metadata with an Admin badge and human-readable reach; RED/GREEN tests distinguish non-admin grants.
- [x] 4.2 Implement transactionally guarded hash rotation and descendant invalidation, with RED/GREEN tests for lifecycle, unchanged grants/history, rollback, cache instances and authentication races.
- [x] 4.3 Add admin/CSRF guarded rotation action, danger confirmation and ephemeral one-time secret response; verify Cancel, duplicate-submit protection, self-rotation and no URL/storage/log delivery.
- [x] 4.4 Verify actual HTTP authentication, MCP continuity and OAuth/session invalidation; mutation-check new guards, independent security verification, full checks and browser evidence.
