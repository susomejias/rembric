## 1. Reproduce and correct

- [x] 1.1 Reproduce CI's three dangling citations with the real cross-reference CLI.
- [x] 1.2 Reproduce Docker's37-versus38 mismatch with its actual shell guard and a passing37-file control.
- [x] 1.3 Add a red/green regression executing Docker and both CI smoke guards against the source inventory, including missing/extra counts.
- [x] 1.4 Update the three citations through complete MODIFIED blocks and all three migration count guards without weakening any delivery gate.
- [x] 1.5 Run repository-level spec gates, targeted tests, formatting and type checks; retain correction deltas for sync/archive provenance.

## Evidence

CI run38160543939 on a8fad60b: test job failed at check:spec-crossrefs; all three Docker jobs reached the assembled tree and reported38 files against37 expected. Retrieval eval and spec provenance passed. Local reproduction matched both failures. Regression logs: `/tmp/rembric-ci-migration-{red,green}.log`. No install-layer, dependency, migration SQL or application API changes.

Repository-level delta-freshness, delta-sections and spec-crossrefs gates passed. Strict correction-change and canonical MCP spec validation passed. Targeted tests40 passed (39 provenance tests plus the migration-guard regression). Three separate guard mutations were caught and sources restored; an initial CI mutation selector matched twice and was corrected to select each smoke independently. Typecheck7 tasks passed,6 cached; changed-file formatting and targeted ESLint passed. Native arm64 Docker runner build succeeded; its real temporary-volume boot returned authenticated healthz200, unauthenticated401 and38 migration applications. Own container and temporary DB were removed. Logs: `/tmp/rembric-ci-{targeted,typecheck,migration-mutations,docker-build,docker-smoke}.log`. This is not a local amd64 build or a completed remote-CI claim.
