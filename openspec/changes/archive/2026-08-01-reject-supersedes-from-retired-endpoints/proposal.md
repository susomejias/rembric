## Why

A `supersedes` verdict rewrites the lifecycle of both endpoints: the target becomes `superseded` and the source's `replaces` array gains the target's id. Nothing checks that either endpoint is still `active`, so a memory retired days ago can demote a live, correct one — with stale content as the declared winner.

Measured against `main` with a throwaway probe: V1 superseded by V2 on a shared `topic_key`, then a pending pair from V1 to an unrelated `active` memory `L`, judged `supersedes`.

```
source V1 status = superseded, target status = active
judged=supersedes | live target is now 'superseded' | dead source replaces=[<L>]
```

Reachable rather than theoretical: pending pairs whose source was later retired accumulate from four producers (a `topic_key` supersede, a `supersedes` verdict, `memory.archive`, the decay pass) and only clear at the 14-day orphan deadline. They surface in `memory.context.pendingJudgments[]` oldest-first, so the agent is actively prompted to adjudicate them (issue #298). An agent that reads a stale prompt and answers `supersedes` gets exactly the corruption above.

Append-only is not violated — the supersede is a `status` flip, journaled in `consolidation_ops` and reversible — but the resulting state is wrong twice over: a correct active memory is retired, and a `superseded` row acquires a `replaces` edge it should never hold.

## What Changes

- A `supersedes` verdict SHALL be rejected with structured code `conflict` when either endpoint is not `active`. The guard lands inside `applySupersedesSideEffect`, which is the single function all three entry points share, so no caller can bypass it.
- Only `supersedes` is blocked. `not_conflict`, `duplicate`, `related`, `compatible` and `scoped` stay closable on retired pairs — deliberately: a `not_conflict` dismissal on a retired source is carried forward to every future revision of the topic through the `replaces` ancestry (`memory/spec.md:511` and its scenario at `:1331`), so blocking those would break specified suppression behaviour and leave the pairs to orphan uselessly.
- `findScopeTupleById` gains `status` in its projection. The source row is already fetched there; the target is currently not read at all — `markSuperseded(targetId)` runs blind — so the target's lifecycle read is new.
- **The `topic_key` audit relation moves INTO `saveWithTopicKey`'s transaction.** `memory` spec "Second save with the same `topic_key`" requires the insert, the supersede AND the `agent_topic_key` relation row to happen "within a single transaction". They did not: `saveWithTopicKey` committed, then the MCP layer called `compare` in a second transaction — which also _performed_ the supersede again, re-retiring an already-retired row and rewriting an identical `replaces` on every such save. `MemoryService` now writes that row itself (its repos `Pick` gains `'relations'`), and the MCP follow-up call plus its `catch {}` are deleted. This makes the spec true for the first time, removes the redundant writes, and is why the guard never sees the audit row.
- **`supersedes` stays idempotent.** `memory.compare` carries `idempotentHint: true` and `mcp-api` §"Tool annotations" classifies it last-call-wins. The guard therefore exempts the case where the requested end state already holds (`target` is `superseded` and the source's `replaces` already names it): re-applying is a no-op, provably not the corruption being prevented, so a retry succeeds instead of raising `conflict`.
- Not **BREAKING** for any correct caller: every rejected call is one that would have corrupted state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: adds a requirement constraining when a `supersedes` verdict may be applied. This is where the side effect is already specified for both tools that can trigger it — `memory.judge` ("When `relation = 'supersedes'`, the server SHALL transition the target memory to `status = 'superseded'` and append the target's id to the source's `replaces[]`", `spec.md:890`) and `memory.compare` (classified a write at `:1376` precisely because it "flips the target memory's `status` to `superseded` and appends to the source's `replaces[]`"). Both existing requirements are unchanged; what is new is the precondition on both endpoints' lifecycle.

## Impact

Durable invariants touched: **append-only memory** — specifically its lifecycle rules. This change strengthens them: it removes a path by which a `status` flip could be applied on the authority of a row that no longer represents the topic. No row is deleted, no `content` is updated, no new mutation verb appears, and the `consolidation_ops` journal is unaffected. Scope enforcement, `topic_key` convergence and the derived review state are untouched.

Code:

- `apps/server/src/services/relations.ts` — `applySupersedesSideEffect` (~:552-561) gains the guard. Its three callers are `applyJudgment` (~:299, reached from `judge` / `judgeInScope`) and `compare` twice (~:357 existing-row path, ~:385 fresh-row path); none changes.
- `apps/server/src/db/repositories/memory-repository.ts` — `findScopeTupleById` (~:407) adds `status` to its `select`.
- `apps/server/src/services/memory.ts` — `saveWithTopicKey` writes the `agent_topic_key` relation row inside its own transaction; the repos `Pick` gains `'relations'`. Precedent for the cross-aggregate write in the same transaction: `MemoryService.archive` already journals to `consolidation_ops` that way, for the same attributability reason.
- `apps/server/src/mcp/memory-tools.ts` — the follow-up `compare` call, its `catch {}`, and the now-unused `tokenName` parameter of `saveMemoryWithCandidates` are deleted; `mcp/observability-tools.ts` and `test/retrieval/ingest.ts` drop the argument. The actor now reaches the row through `input.source.tokenName`, which `memory.save` and `capture_passive` already populate.

Tests:

- `apps/server/src/services/relations.test.ts` — cases per entry point (guarding one function protects three doors, asserted rather than assumed), the idempotent-retry pair, and the atomic audit row written by the save itself.
- `apps/server/src/scripts/seed-volumetric.test.ts` — the corpus now carries one `agent_topic_key` row per superseded memory, so the declared relation total is `generated + memories * supersededFraction`. Its determinism digest also stops ordering by `id`: several relations share a `created_at`, and an `id` tiebreak let a minted ULID decide the order — write-path randomness the digest documents itself as excluding.

No migration, no schema change, no MCP tool signature change, no dependency change, no plugin change. The structured code `conflict` is the one `applyJudgment` already uses for its already-judged guard, so a caller handling one handles the other.

Related: issue #301 (this change's report), #298 (the queue behaviour that makes these prompts reachable, deferred).
