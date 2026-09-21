# Restore main dashboard parity

## Contract

Replicate main's existing structure and functionality in Next.js with existing shadcn/Spectrum primitives, reducing maintained custom code. Preserve library defaults: accept minor visual differences rather than heavily tuning components or reproducing legacy CSS with overrides. User screenshots of login, overview and memories are the visual reference. No redesign, backend/auth changes, dependencies, database mutations, push or commits in this correction pass. Preserve existing functional contracts. Branch: feat/monorepo-nextjs-redesign.

## Execution

Parallel read-only investigation with one bounded writer; no concurrent writes in the shared worktree. Parent owns this document. RDD off. Strict TDD not activated in the prior task; browser regression evidence is required and must not be substituted with build success. Verification commands are delegated and serialized. Approximate initial scope: 300–700 authored changed lines, revised after mapping; no delivery/PR requested.

## Tasks

- [ ] P1 Restore login composition from main and supplied screenshot. Implementation returned by mubc27xw-5-mgre; comment cleanup mubcb0bk-9-qvqm complete. Only login/page.tsx changed. GET login/error/next checks and scoped lint passed per writer; independent browser verification pending (configured browser missing). Not closed.
- [ ] P2 Reproduce and correct overview overflow and structural mismatch. Explorer mubbwsog-4-8qjp returned source-only evidence (no browser tools). Sole writer mubccamk-a-tl0v now restores main's stat strip and descriptive judgment/session rows, with shared containment/heading fixes. User explicitly selected Spectrum NumberTicker (https://ui.spectrumhq.in/docs/number-ticker) for numeric counters; preserve official component defaults, accessibility and reduced-motion. Independent runtime verification remains required.
- [ ] P3 Map and restore memories/shared view structure against main. Read-only mapper first; shared components changed serially after P1.
- [ ] P4 Independently verify authenticated populated views at desktop/mobile widths, login presentation, interactions, page scrollWidth <= clientWidth, typecheck/lint/format and build. Browser verifier: mubc3ycr-7-ymor. Record exact results and remaining failures.
- [ ] P5 Audit functional parity with actual main, prioritizing updater version/status/check/apply/poll and sidebar entry, then routes/forms/actions/auth/confirmations. Read-only verifier: mubc4xmx-8-26wv. Never invoke destructive operations or updates on the live installation; separate static gaps from runtime-proven defects. User explicitly requested this audit after showing the missing UP TO DATE sidebar entry, then expanded it to all dashboard views and elements. Inventory navigation, filters/defaults/pagination/counts, conditional sections/metadata/links, empty/error/flash states, forms/confirmations and permission boundaries against actual git main. Prioritize content and behavior omissions over acceptable library-default visual differences.

## Evidence

User screenshots: login 2026-09-21 16.18.48; overview 16.19.20; memories 16.19.40. Previous sidebar change 4f770345 was not verified in an authenticated browser. Prior completion claims do not establish parity.
