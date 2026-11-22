## Context

Instrument: client Undici lifecycle timestamps relative to request start (`performance.now`). The real Pi trace records one successful reused-connection request (53.912 ms full body), followed by a timeout after 83 minutes idle: connected at 157.556 ms, sent at 157.908 ms, aborted at 201.465 ms without headers. `apps/plugin/bin/rembric-plugin-core.mjs::doPost` creates `AbortSignal.timeout(timeoutMs)` before `fetch`, so connection setup consumes the same 200 ms budget as the response. A separate series, measured by `fetch` through `arrayBuffer()` wall-clock, returned HTTP 200 in 126.549, 53.802, 56.587 and 56.681 ms; response metadata confirms the Cloudflare path, not culpability.

## Goals / Non-Goals

**Goals:** reproduce this transport pattern through real `fetch` and `createSessionProtocol`, preserve warm hints, and keep a finite best-effort deadline and single POST.

**Non-Goals:** assign blame to Cloudflare, prove original origin processing time, change production, add retries or keepalive traffic, change the server, or guarantee hints on every possible network.

## Decisions

Use a 500 ms total default in the shared JavaScript core. Cold setup and the warm response were measured on different requests; their sum motivates headroom but does not reconstruct the aborted request's completion time. The 170+65 ms controlled HTTPS reproduction demonstrates a healthy cold path exceeding 200 ms. The owner accepts 500 ms as a budget correction to deliver before further root-cause investigation, not proof that every cause of #410 is resolved; it remains below the 3000 ms background budget. Warm successes do not wait for the deadline. Explicit caller deadlines remain unchanged.

Rejected: reusing the 3000 ms background deadline (unnecessarily long turn-start delay), transport-specific agents/dependencies or phase timers (larger implementation and host divergence), periodic keepalive/preflight requests (extra traffic and no guarantee of reuse), retries (extra POSTs), and server warmup changes (cannot eliminate pre-request transport time).

Test with a local HTTPS server delaying TLS SNI negotiation 170 ms and returning a hint 65 ms after receipt. Trust its generated localhost certificate only in an isolated Node subprocess via `NODE_EXTRA_CA_CERTS`; never disable TLS verification. Disable ticket resumption in the fixture so a new TCP connection also exercises the delayed TLS negotiation. Keep the test under `apps/plugin/test/`, alongside the existing shared-core suite executed by the web workspace's Vitest project. This keeps the commit out of the server release component. Verify the test's strict types separately using the existing web workspace's Node/Vitest declarations; add no dependency. Force a fresh connection by closing registration responses, not by sleeping minutes. Compare warm explicit-200 success, cold explicit-200 abandonment, cold-default success, and bounded unresponsive fallback; count hint POSTs and observe real Undici connection events.

## Risks / Trade-offs

[Trade-off] Unresponsive recall may delay turn start 500 instead of 200 ms → Accepted to include reconnection in the total deadline while preserving bounded best-effort behaviour.

[Risk] A larger budget may hide another latency anomaly → Keep #410 open, retain the real trace and investigate connection/response/Pi timing with client-side diagnostics after delivery. Local timings model a possible transport pattern, not the original aborted response's completion; do not claim Cloudflare or origin fault.

[Risk] HTTPS fixture depends on OpenSSL → Use the system executable already available in development and Ubuntu CI; no npm dependency or global trust change.

## Migration Plan

Ship through the unified plugin release only; no server restart or migration. Rollback restores the JavaScript recall constant and its new tests/spec additions. Do not edit version carriers manually.

## Executed Verification

- Red baseline: `pnpm --filter @rembric/web exec vitest run ../plugin/test/recall-hints-cold-connection.test.ts` passed the warm and explicit-200 cold controls, then failed at the default cold hint assertion with the original 200 ms core. The same test passes with 500 ms, including one-POST stalled fallback.
- `node scripts/mutate.mjs --file apps/plugin/bin/rembric-plugin-core.mjs --spec ../plugin/test/recall-hints-cold-connection.test.ts --mutation 'const RECALL_HINTS_TIMEOUT_MS = 500;' --with 'const RECALL_HINTS_TIMEOUT_MS = 200;' --mutation 'const RECALL_HINTS_TIMEOUT_MS = 500;' --with 'const RECALL_HINTS_TIMEOUT_MS = 3000;'`: both mutations caught; source restored byte-identically. The 200 ms mutation loses the cold hint; 3000 ms violates the bounded default diagnostic.
- `pnpm test`: DB 288, MCP 439, core 1007, web 1098 and Hermes 96 passed (2928 total; 16 TypeScript tests skipped). Includes Pi's 83 tests, seven populated call-site hint tests, and the cold TLS fixture. `pnpm run typecheck` and `pnpm run lint` pass.
- Real Pi RPC explicitly loaded the checkout's Pi extension against an isolated local Next.js `start` server, confirmed `memory_save` registration and two recall HTTP 200 responses with this core; no model request, production connection or operator-config install. Scratch HOME/database/processes cleaned. This is not a long-idle test of the operator's running TUI.
- The temporary trace helper and its tests were moved out of the shipping tree. The existing personal diagnostic loader remains local, pointing at scratch tooling, so the operator can observe the updated TUI later; it is not shipped. The installed 0.33.1 core is still unchanged and no release/deployment has occurred.
