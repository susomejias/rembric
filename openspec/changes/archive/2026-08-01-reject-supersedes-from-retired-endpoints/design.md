## Context

`applySupersedesSideEffect` (`apps/server/src/services/relations.ts:552`) is the only code that performs the `supersedes` lifecycle rewrite, and it performs it unconditionally:

```ts
const source = this.repos.memory.findScopeTupleById(sourceId);
if (!source) throw new DomainError('memory_not_found', …);
const nextReplaces = Array.from(new Set<string>([...source.replaces, targetId]));
this.repos.memory.markSuperseded(targetId);
this.repos.memory.setReplaces(sourceId, nextReplaces);
```

The source is fetched but only for its `replaces` array — `findScopeTupleById` projects `{ scope, projectId, replaces }` and no status. The target is not read at all; `markSuperseded(targetId)` writes blind.

Measured on `main` with a throwaway probe: two saves on one `topic_key` (so V1 → `superseded`), an unrelated `active` memory L, a pending relation V1 → L, then `judge({relation: 'supersedes'})`.

```
source V1 status = superseded, target status = active
judged=supersedes | live target is now 'superseded' | dead source replaces=[<L>]
```

The path is reachable without operator error. Pending pairs outlive their source's retirement — four producers create them and only the 14-day orphan deadline clears them — and `memory.context.pendingJudgments[]` surfaces them oldest-first, so a retired source's prompts sort ahead of live ones (issue #298, deferred). The agent is therefore _prompted_ to adjudicate exactly the pairs this defect needs.

Constraint that shapes the design: **three call sites**, not one. `applyJudgment` (`:299`, reached from `judge` and `judgeInScope`) plus `compare` twice — `:357` for the update-in-place path over an existing row and `:385` for a fresh insert. Any guard placed per-caller would be three guards.

## Goals / Non-Goals

**Goals:**

- No `supersedes` verdict can retire an `active` memory on the authority of a row that is itself retired, from any entry point.
- Nothing is persisted on rejection — not the lifecycle flip, not the `memory_relations` transition that shares its transaction.
- Verdicts that merely _record_ something about a pair keep working on retired rows, including the `not_conflict` dismissal whose carry-forward is specified behaviour.

**Non-Goals:**

- Changing which pairs are surfaced, or in what order. The queue behaviour that makes stale prompts reachable is issue #298 and is deliberately deferred; this change makes the wrong answer impossible rather than making the prompt rarer.
- Preventing `memory.compare` from _opening_ a pair on a retired row. Recording a retrospective `related` or `duplicate` observation about retired history is legitimate; only the lifecycle-rewriting verdict is refused.
- Retroactively repairing rows already corrupted by this path. Any such row is a `status` flip journaled in `consolidation_ops` and reversible by the existing operator path; a bulk repair would need to distinguish legitimate supersedes from defective ones, which the journal alone cannot do.

## Decisions

### D1 — Guard inside `applySupersedesSideEffect`, not at the three callers

Chosen: one check in the shared function.

Three per-caller guards are three chances to forget, and a fourth caller added later inherits nothing. Placing it in the function that performs the rewrite makes the precondition part of the operation rather than a convention its callers observe. This is the same reasoning that put the `include_global` decision at one point in the preceding change, and it is why the tests assert all three entry points rather than trusting that one guard covers them.

_Alternative: validate in `applyJudgment` and `compare` separately._ Rejected — strictly more code, strictly weaker.

_Alternative: validate at the MCP handler boundary (`relations-tools.ts`)._ Rejected: `compare` and `judge` are also reachable from `compareInScope` / `judgeInScope`, and the service is the layer that owns the transaction. A boundary check would leave the service's own invariant unenforced.

### D2 — `conflict`, not `invalid_input`

Chosen: `conflict`.

It is what `applyJudgment` already raises when the relation row is not `pending`, so both refusals of the same call are one code, and the batch-judge response contract at `mcp-api/spec.md:890` already documents `conflict` for "an already-closed row". The condition is also genuinely a state conflict rather than malformed input: the same arguments would have succeeded before the endpoint was retired.

### D3 — Read the target's status, accepting one extra query

Chosen: extend `findScopeTupleById` to project `status`, and fetch the target as well as the source.

The source row is already fetched, so its status is free. The target is a second point-lookup by primary key on a cold path (judging is agent-initiated, not per-request), which is the cheapest possible additional read.

_Alternative: a single query fetching both rows._ Rejected as premature — it complicates the repository signature for two PK lookups inside an already-open transaction.

_Alternative: use `unsafeGetById` for the lifecycle read._ Rejected: it returns the full row including `content`, and the `unsafe*` prefix marks cross-scope reads. Widening the existing narrow projection is both cheaper and truer to what the caller needs.

### D4 — Reject the whole call rather than skipping the side effect

Chosen: throw, so the surrounding transaction rolls back and the relation row stays `pending`.

Silently marking the relation `judged` while skipping the lifecycle rewrite would record a verdict the system did not honour — the agent would believe the supersede happened. Leaving the row `pending` keeps the queue honest: the pair is still open, and the agent can close it with a relation that is valid for retired rows.

### D5 — Move the `topic_key` audit relation into the save's transaction

Discovered during implementation: the guard reddened a pre-existing test, `memory.save with topic_key auto-supersedes the prior active row`.

`saveWithTopicKey` (`services/memory.ts`) retires the prior row and sets the new row's `replaces`, then commits. The MCP layer recorded the audit relation afterwards through `compare` — a verb that _performs_ a supersede. Three consequences, all invisible until the guard exposed them:

- **The spec was not being met.** `openspec/specs/memory/spec.md` "Second save with the same `topic_key`" requires "**within a single transaction**: (a) N inserted … (b) M → `superseded`; (c) a `memory_relations` row SHALL be inserted … `marked_by_kind = 'agent_topic_key'`". (c) was in a second transaction. `saveWithTopicKey`'s own docstring claimed otherwise ("so the MCP layer can write the accompanying `memory_relations` rows in the same transaction") and was false.
- **Two redundant writes per superseding save.** `markSuperseded` on a row already `superseded` (a 0-row no-op, since the statement carries `AND status='active'`), and `setReplaces` writing a byte-identical array — which fires `memory_replaces_au`, whose DELETE filters the second column of a `WITHOUT ROWID` primary key with no secondary index, so it SCANs. Measured with the committed volumetric harness at 1k/20k/50k: **11.4 / 120.8 / 228.3 µs** removed per save, plus ~4.2 KB of WAL. The cost was linear in `memory_replaces`.
- **A `catch {}` hid the failure.** The audit write was wrapped in a best-effort catch, so under the guard the save would have succeeded while the specified relation row silently vanished.

Chosen: `MemoryService.saveWithTopicKey` writes the row itself, inside its transaction. Its repos `Pick` gains `'relations'` — one word, and no call site changes because all 59 construction sites pass a full `createRepositories(...)`. The MCP follow-up call, its `catch {}`, and the now-dead `tokenName` parameter are deleted.

The precedent is in the same class and twenty lines away: `MemoryService.archive` already writes `consolidation_runs` + `consolidation_ops` through `repos.consolidation` inside the same transaction as its status flip, for the same reason — an agent-initiated lifecycle change must be attributable and reversible atomically.

_Alternative first implemented, then discarded: a `recordAppliedSupersede` verb on `RelationsService` that writes the judged row without the side effect._ It worked and its tests passed, but it is an exemption authenticated by nothing more than the method's name — no caller is obliged to have actually performed the transition — and it left the spec's single-transaction requirement unmet and the `catch {}` in place. Moving the write dissolves the need for an exemption instead of documenting one.

_Alternative: exempt `marked_by_kind = 'agent_topic_key'` from the guard._ Two lines, and safe from abuse (`kind` is server-set, absent from `compareSchema`). Rejected for the same reason: it encodes the exception as a magic string and leaves both the redundant writes and the spec gap.

_Alternative: pass the retired target's expected status into the recorder._ Rejected — the caller would supply the value the check compares against, reading it from the row the service would read anyway. Trust in a name becomes trust in an argument, with no added assurance.

### D6 — The guard must not break `compare`'s idempotency

`memory.compare` ships `idempotentHint: true` and `mcp-api` classifies it last-call-wins, and `RelationsService.compare`'s docstring promises a second identical call updates in place. A bare both-endpoints-active guard breaks that: the first `compare(supersedes)` retires the target, so an identical retry hits `conflict`.

Chosen: exempt the case where the requested end state already holds — `target.status === 'superseded'` AND the source's `replaces` already names the target. That is provably not the corruption being prevented (the supersede this call asks for has already been applied, by this pair), it restores the specified idempotency, and it skips the redundant `setReplaces` that a re-apply would otherwise perform.

It cannot readmit the defect: in the #301 case the target is `active`, so the exemption cannot fire. Asserted directly.

_Alternative: drop `idempotentHint` from `memory.compare` and amend the annotations requirement._ Rejected — it would weaken a published contract to accommodate a guard, when the guard can be made precise instead.

## Risks / Trade-offs

- [Risk] An agent mid-workflow now gets a `conflict` where it previously got success, and may retry the same call in a loop → Mitigation: the error message names which endpoint is not active and its status, so the agent can pick a valid relation instead. The batch form already returns per-item codes without aborting siblings, so one refused item in a batch does not strand the others.
- [Risk] The guard reads status inside the transaction, so a concurrent retirement between check and write could still slip through → Mitigation: `db/client.ts` holds a single synchronous connection, so there is no concurrent writer within a transaction; `markJudged({ requirePending: true })` already relies on the same property.
- [Trade-off] Rows already corrupted by this path are not repaired (a Non-Goal) → Accepted because distinguishing a defective supersede from a legitimate one after the fact needs information the journal does not carry. An operator who suspects one can reverse it through the existing journaled path.
- [Trade-off] `memory.compare` can still _open_ a pair on retired rows (a Non-Goal) → Accepted: that is how an operator records a retrospective observation, and it cannot corrupt lifecycle now that the verdict is refused.
- [Risk] The audit insert in `MemoryService` is the only `memory_relations` write that does not pass through `RelationsService.assertSameScope` → Mitigation: cross-scope is impossible by construction here, because `findActiveByTopicKey` locates the target by `(scope, project_id, topic_key)`, so target and source always share a scope. Verified: the same `topic_key` in two projects leaves the first row `active` and writes no relation. Worth an invariant test if a second in-service relation write ever appears.
- [Risk] The corpus the volumetric harness builds changed shape — it now carries one `agent_topic_key` row per superseded memory, coupling the relation axis to the memory axis it was written to keep independent → Accepted, and it is a correction: production always writes that row, so the harness had been measuring against a corpus missing rows real deployments have. Published `tune-hot-query-paths` figures were taken on the thinner corpus and are therefore optimistic on relation-heavy reads.

## Migration Plan

None. No schema change, no data change, no dependency change. Rollback is reverting the commit; the guard writes nothing, so there is no state a rollback would strand.

## Open Questions

None blocking. One adjacent question deliberately left to #298: whether the queue should stop surfacing retired-source pairs ahead of live ones. This change removes the damage that made that ordering dangerous, which lowers #298's severity from "can corrupt data" to "wastes a slot".
