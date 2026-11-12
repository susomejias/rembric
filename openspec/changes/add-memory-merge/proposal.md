## Why

Redundancy is one of the four things consolidation targets ("The consolidation MUST target redundancy, drift, contradiction, and decay"), but an agent can only collapse redundant memories **pairwise**: a `supersedes` verdict through `memory.judge_batch` / `memory.compare`, or a `topic_key` upsert. Five memories that each hold part of one convention cannot become one coherent memory: the agent would save a new memory and judge it against each of the five separately, and nothing records those six steps as one decision that can be undone together (issue #450).

The storage model already supports the many-to-one case and nothing produces it: `memory.replaces` is an array, `'merge'` is still a member of `CONSOLIDATION_OP_TYPES`, and `undoOp` already reactivates a merge's originals and archives its successor. Outside tests, nothing writes a `merge` op.

## What Changes

- **New MCP tool `memory.merge`** with a two-phase contract on one tool. Called without `fingerprint` it is a **preview** that writes nothing and returns the resolved originals (bounded previews), the successor exactly as it would be stored, warnings, and an opaque `fingerprint` over the inputs and the current state of every original. Called with that `fingerprint` it **confirms**: in one transaction it inserts the successor with `replaces = [ids…]`, flips every original to `superseded`, and journals a single `merge` op in its own `consolidation_runs` row with `scope = 'maintenance'` (as `memory.archive` does, so the sweep's per-project throttle is not tripped).
- **Stale previews never merge.** On confirm the server recomputes the fingerprint; when it differs it writes nothing and returns the MCP error `fingerprint_mismatch` carrying the fresh preview.
- **Constraints:** 2 to `MERGE_MAX_IDS = 10` distinct ids (10 = `PREDECESSOR_CAP`, so the successor's history lists every original); every id `active` and inside the connection's effective scope (cross-scope → `not_found`, non-active → `conflict`); write access for both phases.
- **`topic_key` rules:** an omitted key inherits the single distinct non-null key of the originals; several distinct keys refuse the merge until the caller names one; a caller-named key held by an active memory outside `ids` is refused with `conflict` naming the occupant.
- **No carry-over, no new relations.** Confirmations stay on the originals (the successor is new text and starts fresh). The merge writes no relation rows and copies none; pending judgments touching an original are a preview warning and are left as they are.
- **Normal save pipeline.** After commit, the successor goes through the same post-commit steps as `memory.save` (embedding, candidate detection, entity linking), extracted into one shared helper.
- **Undo ordering fix.** `undoOp` archives a merge's successor **before** reactivating its originals. Today an original that shares the successor's `topic_key` is skipped as "slot occupied" by the successor itself, so undo does not restore every original.
- **Consolidation spec:** the journal requirement now names agent-driven merges as a producer of `merge` ops.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: ADDED requirement "The MCP server MUST expose `memory.merge` with a preview-then-confirm contract".
- `consolidation`: MODIFIED "Every consolidation decision MUST be journaled" (agent merges journal `merge` ops) and "Every consolidation operation MUST be reversible" (merge undo archives the successor first; new scenario).

## Impact

- `packages/core`: `MemoryService.previewMerge` / `commitMerge`, `undoOp` ordering.
- `packages/mcp`: `memory.merge` registration, handler, output schema, shared post-save helper; catalog wiring (authorization, annotations, description ceiling, instructions).
- Docs and plugin-facing tool lists that enumerate the catalog.
- No migration: no schema change, no new op type, no new relation kind.
