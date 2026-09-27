## 1. Align the contract with the shipped behaviour

- [x] 1.1 Record the owner decision chain in `odd/tasks/dashboard-nav-datatable-consistency.md`: judgments badge keeps the full total with a paginated table; memories badge becomes the active-only lifecycle total ("la spec se debe violar en este caso", then "ajustamos la spec para que no engañe").
- [x] 1.2 Implement the target behaviour on `main`: commit `f71e3b17` — `navTotals()` reports active memories only; `tokens.count()` repaired in the same unit.
- [x] 1.3 Verify no regression: `pnpm --filter @rembric/web test` — 58 files, 1087 passed, 6 skipped.

## 2. Spec delta

- [x] 2.1 Write `specs/dashboard/spec.md` as a MODIFIED block replacing the whole needs-review badge requirement, with updated scenarios (active total, omitted at zero, excludes retired rows).
- [x] 2.2 Validate the change with `openspec validate --strict`.
- [x] 2.3 Archive the change once the owner approves, merging the delta into `openspec/specs/dashboard/spec.md:1314-1328`.
