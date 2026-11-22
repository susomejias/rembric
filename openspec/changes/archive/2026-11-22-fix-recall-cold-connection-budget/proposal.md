## Why

Issue #410 now has a real Pi client trace: a reused connection returned the full response in 53.912 ms, whereas after 83 minutes idle a new connection consumed 157.556 ms before the request was sent, and the overall 200 ms deadline aborted it at 201.465 ms without headers. The controlled HTTPS reproduction shows that 200 ms can discard a healthy response when reconnecting. The real trace does not reveal when its aborted response would have completed or establish an origin or Cloudflare defect; this budget adjustment does not close the root-cause investigation.

## What Changes

- Give the shared JavaScript recall client a 500 ms end-to-end default, including connection establishment and response consumption, still below the existing 3000 ms background POST deadline.
- Preserve explicit deadlines, abandonment, empty-hint fallback, and no retries; add no timers for keepalive, preflight requests, dependencies, or production instrumentation.
- Prove the transport boundary with a trusted local HTTPS fixture: delayed TLS negotiation and a fast response, plus warm-connection and unresponsive-server controls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plugin-session-protocol`: bounded JavaScript recall deadline must accommodate connection establishment, with executable cold/warm controls.
- `pi-plugin`: the turn-start recall path inherits the shared deadline without a Pi-specific override or retry.

## Impact

`apps/plugin/bin/rembric-plugin-core.mjs` and `apps/plugin/test/recall-hints-cold-connection.test.ts`; Pi and opencode use the same JavaScript implementation. No HTTP API, server, installer, dependency, migration, release carrier, or load-bearing memory invariant changes. The worst-case turn-start wait rises from 200 to 500 ms; successful warm requests are unchanged. The existing local diagnostic helper remains temporary investigation tooling, not part of the fix.
