# Fix confirmed migration audit regressions

## Intent and authorization

Restore existing contracts lost during the Next.js migration and repair two faulty tests. User authorized implementation after the read-only audit, without commits or pushes. Baseline is immutable `c64934f569b9f909d2131cde13b4e3d85ad583b5`; candidate starts at `18e0ab1059b4ca05aa2727a666837cd2d5a3a555`. Published 0.28.6 (`d9944ff`) upgrade evidence is a separate comparison.

## Safety

Never read or source the repository `.env`, real credentials, profiles, or databases. A prior installer probe overwrote the repository token/port; recovery is separate and unresolved. No installer execution, dependency installation, live Pi interaction, existing-container changes, or production operations. Runtime probes must use explicit absolute temporary cwd, synthetic environment and isolated data. No Docker builds until separately coordinated. No parallel writers.

## Implementation route and checks

Delegated direct: one bounded writer per unit, sequentially. Mapping completed by `mud32jpc-j-z8mr`; each unit needs multiple source/test reads or nontrivial changes. Strict TDD was not activated in the existing migration task; use regression-first checks with observed failures wherever feasible, then passing checks. New guards require mutation evidence per repository policy. Native review availability and independent verification remain to be assessed after each writer returns; no approval assumed.

Forecast: approximately 350–650 authored lines across five units, advisory only. Delivery strategy: ask-on-risk, no delivery currently authorized; preserve coherent source/tests rather than trimming coverage to fit a line count.

## Tasks

- [x] M1 Map minimal edit surfaces, existing contracts and test runners.
- [x] F1 Restore post-auth per-token MCP rate limiting. COMMITTED ce275547 (pushed): direct `rate-limiter-flexible@11.2.1`, 29 focused tests pass, typecheck/diff pass, invariants 101/101, independent verification (mud5bh5d-t-c888) confirmed all claims with one lint finding — now fixed inline: 2 import-order errors auto-fixed, `expect.any(Number)` unsafe-assignment replaced with deterministic `retryAfterSeconds: 1` (contract clamp makes it deterministic with burst=1). Re-ran: lint exit 0, 29/29 pass. Mutation evidence for guards is documented in tasks.md §4.4 (claimed by writer, not independently re-executed). Verify valid/invalid credentials, token independence and OAuth token identity, refill/burst and 429 metadata as required by the legacy contract. Runner: `pnpm --filter @rembric/web exec vitest run src/test/mcp-http.test.ts src/test/rate-limit.test.ts`.
- [x] F2 Restore legacy `REMBRIC_PORT` behavior. COMMITTED 20dcc901 (pushed): Node launcher (REMBRIC_PORT > PORT > 8787, fail-fast), --healthcheck probe, next-server.js rename, 11 focused tests + 3 invariants, 7 mutations caught. Container runtime rehearsal still pending.
- [x] F3 Restore prompt Delete/Undelete. COMMITTED bc16d4eb (pushed): Server Actions + guardAction/CSRF + warn confirm, 64 dashboard tests green, 6 mutations caught, OpenSpec change valid using existing service methods, `guardAction`, CSRF fields and reversible confirmation. Verify action authorization, state changes, idempotence and UI wiring. Runner: `pnpm --filter @rembric/web exec vitest run src/test/dashboard/prompts.test.tsx`.
- [x] F4 Correct benchmark bindings. COMMITTED bdf5a9cb (pushed): production order (project_id, ladder x2, nowMs), ladder from reviewTtlEntries(), placeholder-vs-bind invariant, gated 9/9, 2 mutations caught in SQL placeholder order and prove query equivalence. Run all nine gated cases: `REMBRIC_BENCH=1 REMBRIC_BENCH_SIZES=1,2,3,4 REMBRIC_BENCH_REPEATS=1 REMBRIC_BENCH_CONFIRMS=1 pnpm --filter @rembric/db exec vitest run src/repositories/review-reads.bench.test.ts`.
- [x] F5 Remove concurrent arrival-order assumptions. COMMITTED ab0d3c89 (pushed): real flake was :821 (pre-existing on origin/main); slice+sort-by-id rewrite + correlation-by-ID map, 10/10 stable, both probes non-vacuity-proven in bridge tests while preserving response correlation and bounded session recovery. Production bridge stays unchanged. Runner: `pnpm --filter @rembric/web exec vitest run ../plugin/mcp-bridge/bridge.test.ts` (verify runner inclusion before relying on it).
- [ ] V1 Aggregate verification after batch: full web+db+plugin suites, lint/format/typecheck, diff check; then final report of fixes, evidence and limits.

## Evidence and exclusions

Upgrade rehearsal: old Compose port8799 baseline200 vs candidate000; candidate internal8787 responds200. Same authenticated MCP burst yielded baseline429 vs candidate200. Prompt controls absent in candidate runtime but required by dashboard spec869–905. Gated benchmark had5pass/4fail with excess bind values. Bridge repeated tests had3pass/5fail attributable to concurrent order.

No fixes in this batch for unproven automatic-consolidation/model-marker findings, pre-existing token-in-URL behavior, or the HTML pattern warning. Installer recovery and incomplete audit coverage remain open, not silently completed.

## Progress

Mapping complete. F1 writer `mud37pyd-k-p5xs` finished paused with no source edits. Its incompatibility finding concerns the default `express-rate-limit` fixed-window implementation, not all libraries. Parent inspected the published `limiter@4.1.0` tarball: integrity matched registry, no production dependencies/install scripts or links, published 2026-09-11; exact-version OSV query returned no advisories. One maintainer and absent provenance metadata remain caveats, not proof of safety. Verifier `mud3jv9d-m-bbo4` stopped before package execution; no equivalence result exists. Read-only scout `mud3lc7x-n-fzws` proposed a narrow Express-style adapter but did not inspect actual package member accesses. Verifier `mud3plhy-o-vflk` passed the installed `express-rate-limit@8.5.1` Node 22 probe (exit 0): 429/Retry-After, reset, key isolation, body and streaming controls, no runtime Express import. The shim alone has 34 nonblank lines; configuration/invocation are additional. Parent read the probe. This is not actual MCP end-to-end proof. Mapping complete. F1 replaced the Express adapter after user rejected its complexity: writer `mud4wyey-s-vbly` landed `rate-limiter-flexible@11.2.1` direct integration (`consume(tokenId)`, fractional `durationSeconds`, 429 JSON + Retry-After, fail-closed on unexpected errors), RED→GREEN with 29 passing focused tests, typecheck, diff check and targeted mutations. Parent re-ran the focused suite (exit 0) and read the final `rate-limit.ts` (108 lines, 1 cast). Independent verifier `mud5bh5d-t-c888` is running the full claim check including invariants and lint. Next unit: F2 REMBRIC_PORT. Other fixes remain queued, with one writer at a time.
