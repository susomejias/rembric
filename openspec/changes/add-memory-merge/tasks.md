## 1. Undo ordering

- [x] 1.1 RED: `undoOp` on a merge whose successor inherited an original's `topic_key` skips that original (`packages/core/src/consolidation/operations.test.ts`).
- [x] 1.2 GREEN: archive the successor before reactivating originals in `undoOp`.

## 2. Service

- [x] 2.1 Extract `validateSaveFields` from `saveWithTopicKey` and reuse it for the merge plan.
- [x] 2.2 `MemoryService.previewMerge` / `commitMerge` with fingerprint, warnings, `topic_key` rules and the `maintenance` journal run (`packages/core/src/services/memory-merge.ts`, `memory.ts`).
- [x] 2.3 Tests per rule in `packages/core/src/services/memory-merge.test.ts`, every guard mutation-checked.

## 3. MCP tool

- [ ] 3.1 Extract the post-commit half of `saveMemoryWithCandidates` into a helper shared with merge.
- [ ] 3.2 `memory.merge` schema, output schema, handler and registration with the steering description.
- [ ] 3.3 Catalog wiring: `WRITE_TOOLS` (`mcp-transport.test.ts`), `MINIMAL_ARGS` (`unresolvable-slug.test.ts`), authorization test, `statusForCode` for `fingerprint_mismatch`.
- [ ] 3.4 Handler tests at the MCP boundary: preview, confirm, mismatch + control, read-only token, cross-scope, end-to-end undo through the dashboard's `undoOp` service.
- [ ] 3.5 Docs that list the tool catalog (`docs/agents.md`, `docs/relations.md`, README).

## 4. Close

- [ ] 4.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.
