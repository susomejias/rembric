## 1. Reproduction

- [x] 1.1 Capture and preserve the real Pi failing trace, with the successful warm control and production untouched.
- [x] 1.2 Run the real-fetch trusted-HTTPS cold/warm regression against the existing core and observe the default cold case fail.

## 2. Correction

- [x] 2.1 Set the shared JavaScript default to 500 ms, preserving explicit deadlines, no retries and fallback.
- [x] 2.2 Run the cold/warm/unresponsive controls and mutation back to 200 ms; record executed evidence in this design.

## 3. Validation

- [x] 3.1 Run shared-core and Pi/opencode regression suites, relevant invariants, typecheck, lint, formatting and OpenSpec validation.
- [x] 3.2 Exercise the changed client against a real isolated local Next.js server; retain evidence and move temporary tracing/prototypes outside the shipping tree.
- [ ] 3.3 Operator-only: after the plugin update, observe the existing TUI across idle reconnection and retire its personal trace loader. Do not deploy temporary server instrumentation.
- [ ] 3.4 Investigate the real variable latency after delivery using client-side connection/response/Pi timing; do not treat the budget correction as root-cause closure of #410.
