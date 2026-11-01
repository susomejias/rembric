## 1. Contract

- [x] 1.1 Write design and delta specifications for revoked-only confirmed deletion.
- [x] 1.2 Validate the change before implementation.

## 2. Persistence and service

- [x] 2.1 Add behavior tests and observe focused RED for deletion, access, and retained history.
- [x] 2.2 Generate the nullable deletion migration and implement conditional tombstones and service validation; observe focused GREEN.
- [x] 2.3 Add mechanical deletedAt null fields to schema-derived Token literals.

## 3. Dashboard

- [x] 3.1 Add guarded immutable-ID deletion with CSRF and revoked-only danger confirmation.
- [x] 3.2 Verify action authorization and confirmation/cancel wiring with focused tests and real-browser cancellation/confirmation.

## 4. Verification

- [x] 4.1 Parent: mutation-check deletion guards and run typecheck/lint.
- [x] 4.2 Parent/operator: run broad suites and browser smoke with a scratch database before shipping.

## Evidence

- Parent and independent verifier: core token tests 31/31, dashboard action/table tests 9/9, migration/schema tests 28/28.
- Nine service/repository/cookie guard mutations and one form-bound CSRF mutation were caught; source files restored byte-identically.
- Scratch browser: active rows offer Revoke only; Cancel preserves an undeleted row; Confirm removes the revoked row and updates counts. At 390px, no document overflow. Next compilation/runtime error probes were empty.
- `pnpm run build`, `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, targeted Prettier checks and `openspec validate delete-revoked-tokens --strict` passed.
- Docker/CI inventory gates now require 39 SQL migrations; the executable gate test rejects 38 and 40. Docker multiarch image builds remain CI-owned; no delivery was performed.
