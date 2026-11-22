## 1. Bridge

- [x] 1.1 Abort in-flight requests with a stdin-closed reason when stdin ends, and skip failure handling for a request aborted with that reason.

## 2. Tests

- [x] 2.1 RED then GREEN: a notification held open across stdin closing exits `0` without a transport failure.
- [x] 2.2 RED then GREEN: a request held open across stdin closing relays nothing to stdout and exits `0`.
- [x] 2.3 Control: a notification transport failure still exits non-zero and errors a held request.
- [x] 2.4 Mutation-check the guard with `scripts/mutate.mjs`.
