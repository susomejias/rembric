# Tasks

## 1. Decide code-vs-spec, per finding

- [ ] 1.1 For each finding in `proposal.md`, record the verdict (amend spec / change code) in `design.md` before touching anything. Several are genuine design calls, not transcription.
- [ ] 1.2 Confirm the `dashboard` entity-view scope decision with the operator surface's existing precedent (`/dashboard/memories` is unscoped-by-token) rather than in isolation.

## 2. Tool descriptions the agent reads every turn (highest severity)

- [ ] 2.1 `memory.search` `entity`: thread `status`/`type`/`tag`/`topic_key` into `findMemoriesByEntity`, or delete the combinability claim. Test both filters against an entity with mixed-type links.
- [ ] 2.2 Bound the entity branch by `RANK_WINDOW_CEILING` instead of `clampLimit`'s 8, or drop "complete — no ranking, no cutoff". Test: 12 linked memories, no `limit`.
- [ ] 2.3 `topic_key`: omit the `status='active'` predicate when `topicKey` is set and `status` is absent, so the documented "every memory ever saved under a given key" is reachable. Test: 4 saves under one key.
- [ ] 2.4 Thread `includeGlobal` into `entityScopeCondition`. Test: a global memory and a project memory sharing one path, project-scoped read with the flag both ways.
- [ ] 2.5 Re-read every changed `description` string against the amended spec; the runtime contract and the file must agree.

## 3. Record the refutation channel

- [ ] 3.1 Add a `mcp-api` requirement for `memory.confirm`'s `verdict`/`reason`, the `invalid_input` on a reasonless refute, and the response shape.
- [ ] 3.2 Add the review-queue consequences: refuted rows surface, refutation does not advance the affirmation baseline, and re-affirming clears it.
- [ ] 3.3 Update `CONFIRM_DESCRIPTION` to mention refutation.
- [ ] 3.4 Record the read-time escalation signal (`reviewEscalated`) as a requirement, now that `ab7a5f6` made it the only escalation mechanism.
- [ ] 3.5 Decide the refuted-TTL-less case: a refuted `reference` reports `needs_review` indefinitely with no terminal state — the exact limbo the escalation requirement exists to close. Give refutation its own clock or state the exemption.
- [ ] 3.6 Time-bound the refuted-first ordering in the review queue. `refutedExpr` is the leading sort key with no age decay, so with `memory.context` capped at 3 a handful of refuted rows starve every TTL-expired row permanently — verified reproducible a year on.

## 4. Record undocumented load-bearing behaviour

- [ ] 4.1 `memory.context`'s entity pre-pass: precedence over hybrid search, and the `via` field.
- [ ] 4.2 `persistence`: DDL for the three entity tables, 0022 and 0024 — including `memory_entities_identity_idx` as the named cross-project isolation guarantee.
- [ ] 4.3 Decide on `CHECK (verdict IN ('affirm','refute'))`. 0024 ships without one, so the domain is service-enforced only; needs the table-rebuild dance.
- [ ] 4.4 Decide the entity-channel similarity units, or normalise them so the `max(vec, fts)` merge compares like with like.
- [ ] 4.5 Name the constants no requirement mentions: `RANK_WINDOW_MARGIN`, `ENTITY_RARITY_THRESHOLD`, `ENTITIES_PROJECTION_CAP`, `RELEVANCE_LIMIT`, `ESCALATION_MULTIPLIER`, `PREDECESSOR_CAP`, `REBUILD_MAX_BATCHES`. Include the diversity cap and its disabled state.

## 5. Strike the self-contradictions

- [ ] 5.1 Grep every spec for `last_seen_at`, "touch", "on every read", "access signal" and reconcile each hit against the three actual touch sites (`memory.get` single-id, `memory.confirm` with `verdict='affirm'`, undo-decay).
- [ ] 5.2 Fix the passage added by this batch that argues for the relevance channel from the premise the batch deleted.
- [ ] 5.3 Reconcile batch `memory.get({ids})` deliberately not touching, against the new scenario requiring a fetch-by-id to advance the signal.
- [ ] 5.4 `sessions`: amend the startup-only retirement requirement to cover both passes and `COALESCE(last_activity_at, started_at)`; the appended periodic requirement contradicts it.
- [ ] 5.5 `memory`: scope the "rank-1 single-branch outranks bottom-of-window both-branches" claim to _before_ the post-fusion boost — the reachable boost ratio (1.5) exceeds the fusion margin (1.6%), and a sibling requirement blesses that reordering.
- [ ] 5.6 `memory`: the gap-ratio filter is specified relative to the best score; the code compares consecutive pairs, and the floor and gap are evaluated in different score spaces.
- [ ] 5.7 `mcp-api`/`memory`: `memory.get` no longer returns the full predecessor chain (capped, projected, no content) and never returned the specified `source` field.
- [ ] 5.8 `memory-entities`: reconcile "no fusion, no rank window, no similarity threshold" with the 400-row bound and the case-insensitive `includes()` filter; and the "package name" scenario, which a nearby line declares unsupported.
- [ ] 5.9 `mcp-api`: correct the `memory.stats` and `memory.doctor` response shapes — `stats` lists three fields that do not exist and omits three that do, including the two counters this batch's own requirement added under "no returned counter SHALL be undocumented".
- [ ] 5.10 `data-access`: carve out the boot-time doctor closure explicitly, and delete the "or be aggregate-count methods" clause that reopens the loophole. Prefix or rescope `vectors.backlogCount()` and `consolidation.latestRun()`.

## 6. `docs/backup.md` and the restore path

- [ ] 6.1 Document deleting `entity-state.json` and `embedding-state.json` before booting on a restored DB, and why a _surviving matching_ marker is the hazard while absence is safe.
- [ ] 6.2 Classify all five derived tables (`memory_fts`, `memory_vec`, and the three entity tables) as regenerable from `memory` alone.
- [ ] 6.3 Fix the `REMBRIC_ALLOW_DATA_SHRINKAGE` instructions — via `.env`, or add the var to the compose `environment:` block.
- [ ] 6.4 Drop the "admin bearer token from cron" claim for the backup form endpoint; point unattended automation at litestream or the cold copy.
- [ ] 6.5 State the data-loss guard's real trigger (≥50% drop in a monitored table, previous count > 0).
- [ ] 6.6 `persistence`: "all three derived tables, including `memory_entity_scan`" — the two-table wording makes a rebuild a silent no-op.
- [ ] 6.7 Verify every documented command by executing it, per `persistence`'s own "every documented command SHALL succeed" scenario.

## 7. Meet the evidence bar the spec sets for itself

- [ ] 7.1 Commit the adversarial corpus and a noise-rate script measuring per-kind false-positive rates against the real `sanitizeFtsQuery`, in the shape `retrieval-evaluation` established.
- [ ] 7.2 Re-measure all 12 kinds and correct the justification table. Known wrong: `error_code` is credited 0% "self-terminating under tokenization", but `unicode61` drops `_` as it drops `.`; measured `PERMISSION_DENIED` 50% noise, `NOT_FOUND` 75%. Split the row — the `ERR_*`/`SQLITE_*`/`E_*`/errno families are 0%; `GRPC_STATUS_NAMES` needs its own figure.
- [ ] 7.3 Assert the table's figures in a test so a future kind cannot be added on prose alone.
- [ ] 7.4 Close the two `extractor-rules.test.ts` assertion gaps that let the shipped `path` truncation pass green: examples use `toContain` (over-extraction invisible), and a kind's `rejects` are never run through the _other_ kinds. Both would have caught the defects fixed in `f450f82`.
- [ ] 7.5 Add a regression test asserting `extractEntities` on 200KB of `a.` completes well under 50ms.

## 8. Decisions carried in from the review, still open

- [ ] 8.1 Archived memories are never indexed (`findMissingScans` filters `status != 'archived'`), so `memory.search({entity, status:'archived'})` is structurally always empty, and a recipe bump permanently drops archived links. Either drop the filter (extraction is pure and cheap) or force `includeArchived: false` and record the exclusion.
- [ ] 8.2 An entity lookup during a recipe-bump drain returns empty, indistinguishable from "unknown entity", while the spec mandates empty-on-unknown. Surface a draining flag.
- [ ] 8.3 `truncateAll` runs three DELETEs outside a transaction; a mid-way failure leaves scan rows without links, so backlog reads 0 while the index is permanently empty and the marker is already written. Wrap it, and delete the scan table first.
- [ ] 8.4 `findMemoriesByEntity` has no ordering tiebreaker on millisecond `created_at`, so same-millisecond rows scramble and pages repeat or drop rows.
- [ ] 8.5 Declare the `memory_entity_links` composite primary key in the Drizzle table — it exists only in the migration SQL, and `linkMemory`'s `onConflictDoNothing` depends on it.
- [ ] 8.6 Add the three entity tables to `schema-drift.test.ts`'s expectations; the assertion is subset-only, so a future rebuild dropping one goes unnoticed.
- [ ] 8.7 `ABSTENTION_FLOOR` has no usable dynamic range as designed: with bm25 ≤ 0 the logistic yields ≥ 0.5 always, and measured saturation is 0.980 at 3/200 rows vs 0.5000002 at 150/200. Any floor ≤ 0.5 can never fire and anything above is an IDF cliff. Re-derive on a rank-invariant quantity before calibrating.
- [ ] 8.8 `writeBaseline` sets floors at `measured − 0.05` with no ratchet, so a 0.04 regression passes and re-writing lowers the floor permanently.
- [ ] 8.9 Decide whether `MEMORY_TYPES` becomes `as const` + derived union (as `ENTITY_KINDS` already is). Adding `procedural` took six hand-edits and only one was compiler-enforced.

## 9. Verify

- [ ] 9.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` · `pnpm run eval`.
- [ ] 9.2 Real Docker smoke against pre-existing seeded data for every code change, per the standing constraint.
- [ ] 9.3 Re-read each amended spec end to end for internal consistency, not just at the edited lines — the contradictions found here were all _between_ requirements, not within one.
