## 1. Contract and regression

- [x] 1.1 Revise proposal and add scoped credential/background binding deltas without environment fallback.
- [x] 1.2 Add discoverable contextvar-backed isolation and safe failure tests; capture failures against original implementation.

## 2. Implementation and evidence

- [x] 2.1 Bind scoped credentials on instances and pass explicit tokens through HTTP and context-preserving workers; pass full unittest regression.
- [x] 2.2 Update Hermes README for profile binding and intentional old-host incompatibility.
- [x] 2.3 Independently weaken important guards, observe named failures, restore and validate OpenSpec plus full regression.
- [x] 2.4 Independently verify official Hermes scoped APIs against real local Rembric HTTP and SQLite ownership, including original-code failure and default-profile control.
- [x] 2.5 Run monorepo regression and isolated installer checks.
- [ ] 2.6 Operator-only: verify session creation through the real multiplexed Hermes gateway/dashboard; no Hermes executable is available here.
