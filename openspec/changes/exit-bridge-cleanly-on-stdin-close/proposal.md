## Why

When the host closes the bridge's stdin, the bridge aborts every in-flight HTTP request and is meant to exit `0`. An aborted request whose JSON-RPC message has no `id` (a notification such as `notifications/initialized`) was routed to the transport-failure path, which writes `transport failure: This operation was aborted` to stderr and exits `1`. An aborted request with an `id` was answered on stdout with a `-32000` error the bridge itself caused. The first is a race: it needs the notification's response to be outstanding when stdin closes. Measured with the existing test `exits when stdin closes during a held-open SSE response`, it failed 3 of 30 runs on Node 26.13.1 (linux/arm64) and 0 of 30 on Node 22; holding the notification's response open makes it fail every run on both.

## What Changes

- The abort the bridge issues when stdin closes carries a reason of its own, and a request that fails because of that abort is neither reported to the host nor treated as a transport failure, for requests and notifications alike.
- Every other failure keeps its current handling: a request with an `id` gets a correlated `-32000` error, and a notification failure ends the bridge non-zero, including the aborts that transport-failure shutdown issues.

## Impact

- `apps/plugin/mcp-bridge/bridge.mjs` only; no shared module changes, no dependency change, no server change.
- Tests in `apps/plugin/mcp-bridge/bridge.test.ts` hold a notification and a request open across stdin closing, and a control proves a genuine notification transport failure still exits non-zero and still errors a held request.
