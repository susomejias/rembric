## Context

The batch change added SQL migration0037 and replaced the annotation requirement title. CI's exact migration count and three quoted cross-references were not migrated.

## Goals / Non-Goals

Restore the existing delivery gates without weakening them or changing MCP behavior. No dependency, install-layer or schema changes; no unrelated workflow formatting.

## Decisions

Keep the exact38-file expectations in Docker and both boot probes. A source-inventory regression executes each real shell guard for the complete count and one missing/extra file, so another migration cannot silently leave the delivery counts stale. Correct all three citations through full MODIFIED blocks and archive them with the canonical sync for provenance. Disabling either gate or retaining the retired title as an alias would hide the defect rather than repair it.

## Risks / Trade-offs

[Risk] Counts drift on another migration → The source-inventory regression makes drift a regular test failure.

[Trade-off] Counts remain explicit rather than adding another build-time configuration mechanism → Three small guards and one inventory check preserve the existing delivery contract.

[Risk] A shell guard check is mistaken for a complete container build → Distinguish local guard checks from native Docker builds and remote boot smoke.

## Verification

The pre-fix cross-reference CLI failed with three dangling citations. The Docker shell guard accepted37 and rejected38, matching the CI log. The new regression failed before the count updates and passed after them, including both boot-smoke guards and missing/extra controls.
