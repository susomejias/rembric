## 1. Named rankings

- [x] 1.1 Prove repository and authenticated page tests fail on anonymous counts; preserve boundary and excluded-field checks.
- [x] 1.2 Return display names with slug fallback and render bounded names without merging duplicate labels.

## 2. Verification

- [x] 2.1 Verify both PNG formats omit project names; run focused tests, typecheck, lint and mutation controls.
- [x] 2.2 Verify real and long duplicate names on desktop/mobile in the local browser; keep exports anonymous.

## Evidence

- RED: repository and page assertions rejected the old numeric rankings; existing PNG controls passed. GREEN: 8 repository and 25 web tests, repeated by an independent read-only verifier.
- Mutation checks individually removed display-name selection, slug fallback, and PNG anonymity; each failed its named tests. Sources restored byte-identically.
- Full workspace tests, lint, typecheck, strict change validation and diff checks passed.
- Browser: real server names and synthetic long, duplicate, Other and markup-like names remained separate and escaped at 1470×812, 1280×720, 390×844 and 320×640. No outer/horizontal overflow or overlapping counts; only the smallest mobile needed inner scrolling. Both decoded PNG formats omitted the names, with a positive aggregate-text control.
- Full browser regression passed autoplay, pause/hold, taps, keyboard, reduced motion, all ten scenes and native-share API payload/activation/cancel/retry. The native OS sheet was not automated. The harness dismisses the unrelated update notice only in its isolated browser, waiting for the modal overlay to exit before sending input.
- SQL auditor compared existing, aggregate-first and direct-join statements on migrated synthetic fixtures at 1k/20k/50k. Aggregate-first retained the existing range index without schema changes. Parent executed the actual source query against the auditor's boundary, duplicate-name, fallback, retained-status and tie controls.
