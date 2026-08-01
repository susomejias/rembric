## Context

Two repository reads back the agent-facing judgment queue, and neither looks at the lifecycle of the memories it names:

- `listPendingInScope` (`apps/server/src/db/repositories/relations-repository.ts:376`) — `where(and(eq(memoryRelations.status,'pending'), <age cutoff>, endpointsInScope(...)))`, `orderBy(memoryRelations.createdAt)`, `limit(opts.limit)`.
- `countPendingInScope` (`:402`) — `where(and(eq(memoryRelations.status,'pending'), endpointsInScope(...)))`.

Both already `innerJoin` the `sourceMemory` / `targetMemory` aliases (`:65-66`) because `endpointsInScope` (`:69`) needs them to prove both endpoints lie in the resolved scope. So the fix is one conjunct on an existing `and(…)` over an existing join, in two places.

The consequence of the omission is not that a stale row is _present_ but that it is _first_. The list is `orderBy(createdAt)` capped at `PENDING_JUDGMENTS_DEFAULT = 5` (`apps/server/src/mcp/memory-tools.ts:85`), and a superseded row is necessarily older than the row that superseded it, so retired-endpoint pendings monotonically occupy the head of the page. Measured on `main` (probe reproduced in `proposal.md`): five aged pendings on a source A, one newer aged pending on its successor B, one `topic_key` revision — the page came back **5 dead entries, 0 live**, with `pendingJudgmentsTotal: 6`. The control (`A.status === 'superseded'`, `B.status === 'active'`) passed in the same run.

Constraints that shape the design:

- **The two reads must agree.** `pendingJudgmentsTotal` exists to let a caller tell a page from a queue (`openspec/specs/mcp-api/spec.md:483`). If the list filters and the count does not, the field becomes a lie in the opposite direction — a total that can never be drained.
- **The operator surface reads a different path.** Verified: `/dashboard/judgments` calls `adminListWithContent` (`apps/server/src/dashboard/judgments.ts:59`) and `adminCountWithFilters` (`:63`). Neither is `listPendingInScope`/`countPendingInScope`. Verified callers of the two filtered methods are exclusively agent-facing: `apps/server/src/mcp/memory-tools.ts:1444`, `:1459`, and `apps/server/src/mcp/observability-tools.ts:279`.
- **The queue must still empty itself.** `JUDGMENT_ORPHAN_DEADLINE_MS` (default `14 * 86_400_000`, `apps/server/src/config.ts:151-156`) is the only mechanism that closes an unjudged row, and its selection query is a different method (`findPendingOlderThanInScope`, `:263`, consumed by `apps/server/src/consolidation/runner.ts:156`).

## Goals / Non-Goals

**Goals:**

- A pending pair whose source or target is no longer `active` SHALL NOT consume a slot in `memory.context.pendingJudgments[]`, and SHALL NOT be counted in `pendingJudgmentsTotal` on either surface that reports it.
- The page and its total SHALL remain mutually consistent by construction, not by two predicates that happen to match.
- Nothing about the operator's view of the same rows changes.
- No write, no migration, no schema change: adjudicability is derived at read time.

**Non-Goals:**

- Retiring these rows earlier. The 14-day deadline sweep stays the single retirement path (D3).
- Changing which relations the annotation reads surface. `memory.get`'s `relations[]` comes from `listTouching` / `listTouchingAny` (`:206`, `:220`) and maps a `pending` row to `pending_conflict` (`apps/server/src/services/relations.ts:618`). Leaving that channel alone is a decision, not an oversight: measured after the filter lands, a withheld pair is still annotated on its live counterpart WITH its `judgmentId`, and `memory.judge({relation:'related'})` on that handle returns `status: judged`. Calling the annotation mere history would be wrong — it is actionable. It is also load-bearing: `toOrderedAnnotation` (`apps/server/src/services/relations.ts:594`) is the only projection that still emits the `judgmentId`, so suppressing it would leave no MCP path to the handle and breach `mcp-api/spec.md:2194`. See the Trade-offs section for the pinned divergence.
- Preventing the pairs from being created. Save-time candidate detection is unchanged; a save legitimately raises candidates against rows that are active at that moment.
- Repairing anything retroactively. There is nothing to repair — no row is wrong, only its visibility was.
- The two dashboard/observability suggestions in #298 (a `stale` facet; an empty-`global` warning). Deferred, listed in the proposal.

## Decisions

### D1 — Hide, not demote

Chosen: exclude the rows from both agent-facing reads.

The counter-proposal was to keep them and rank them below live pendings, on the theory that hiding loses information. It does not, here: the audience that might want the information reads a different path. `/dashboard/judgments` keeps showing every pending row, retired-endpoint ones included, with its existing per-row orphan action — verified against the two call sites above, which are `admin*` reads and are not touched by this change. So demotion would buy the agent nothing that hiding does not, at the cost of a second sort key on a per-session read; and the `ORDER BY` cost question that objection raised is moot, because no ordering changes.

_Alternative: a `status`-derived sort key (`ORDER BY endpoint_retired, created_at`)._ Rejected per the above — strictly more query, strictly the same information delivered to the agent, since a demoted row that never reaches the page is a hidden row with extra steps.

_Alternative: return them with a flag and let the agent decide._ Rejected: it spends a page slot to tell the agent about work it cannot do, and the load-bearing verdict on such a pair is already refused server-side (D2).

### D2 — Filter the target as well as the source

Chosen: require `source.status = 'active' AND target.status = 'active'`.

The report is about superseded _sources_, but the asymmetry would be arbitrary. A save-time candidate is a question of the form "how does A relate to B"; if B has been archived or superseded, the question is as dead as if A had been. Corroborating precedent, and the reason this is not merely tidiness: commit `b5f8366` (change `reject-supersedes-from-retired-endpoints`) makes a `supersedes` verdict throw `conflict` when **either** endpoint is not `active` — see `openspec/specs/mcp-api/spec.md:2184-2186`, "The server SHALL therefore verify that the source AND the target are both `status = 'active'` before applying the side effect".

Honest limit on the word _unadjudicable_: it is about the load-bearing verdict, not literally every verdict. `related`, `duplicate`, `compatible`, `scoped` and `not_conflict` still succeed on a retired pair, deliberately — `mcp-api/spec.md:2194` requires them to stay closable, because a `not_conflict` dismissal on a retired source is carried forward through the `replaces` ancestry. What the filter asserts is narrower and still true: prompting an agent to spend a fresh-context slot on a pair whose only lifecycle-relevant answer is refused is a waste of the slot.

_Alternative: filter the source only, matching the reported symptom._ Rejected — it would leave an equally dead class of row on the page and encode the report's sample rather than the property.

### D3 — Read-time derivation; the sweep still retires the rows

Chosen: no write of any kind.

This is the same shape as the derived review state the repo already treats as load-bearing: `reviewState` / `needsReview` are computed in the reads, with no column and no sweep. Adjudicability is a function of two columns the row already joins.

The alternative the issue itself raises — auto-orphan at supersede time, writing a real `orphaned` row with a reason — is truer to the append-only journal and would keep `/dashboard/judgments` counts self-explanatory. Rejected _for now_, not on principle: it is a new mutation on the `saveWithTopicKey` write path (which the preceding change has already made busier), it needs the reason string specified and journaled in `consolidation_ops` to stay reversible, and it must decide what happens to a pair whose endpoint is later reactivated by an undo. The read-time filter removes the agent-facing damage with no write surface at all, and the two are not exclusive — a later change can add the orphaning without unwinding this.

Consequence, accepted: these rows stay `pending` in the table for up to 14 days while being invisible to the agent. That is why `findPendingOlderThanInScope` is deliberately left unfiltered — filtering the sweep's own selection would make them invisible _and_ immortal.

### D4 — One predicate definition, used by both reads

Chosen: a module-level constant beside `endpointsInScope` (`relations-repository.ts:69`), applied in both methods.

`endpointsInScope` is the precedent and the reason it exists: the scope rule is one definition because two copies drift. The same argument applies with more force here, since the drift failure is silent — a list and a total that disagree look like a working feature. Unlike `endpointsInScope` it takes no scope argument, so it is a `const` holding the built `SQL` rather than a function — one conjunct dropped into two `and(…)` calls.

_Alternative: fold the predicate into `endpointsInScope`._ Rejected: that helper serves reads which must keep seeing retired rows if any is added later, and conflating "in scope" with "still active" would make the next such read wrong by default rather than by choice.

_Alternative: filter in `memory-tools.ts` after the read._ Rejected on two counts — it would break the cap (five rows fetched, some dropped, a short page that is not the end of the queue), and it would put a lifecycle predicate outside `db/`, which the data-access confinement invariant exists to prevent.

### D5 — `memory.doctor` and the dashboard badge stay unfiltered

`memory.doctor`'s `review.pendingJudgments` comes from `adminCountByStatus('pending')` (`apps/server/src/server/bootstrap.ts:563`) and is server-wide, not scope-resolved — which `openspec/specs/memory/spec.md:983` already states as deliberate ("The equivalent field in the `memory.doctor` report SHALL be server-wide rather than scope-resolved"). The dashboard sidebar badge is fed from the same admin count.

Chosen: leave both. They are inventory counters over the table, they already differ from `memory.stats` for scope reasons, and filtering an `admin*` count would give the operator a number that hides rows their own list shows.

Residual, accepted and asserted rather than hidden: an agent that calls both tools can see `doctor.review.pendingJudgments` exceed `stats.pendingJudgmentsTotal` by the retired-endpoint rows. The spec delta pins the divergence with a scenario so it reads as intent, not as one of the two numbers being stale.

### D6 — Measured: the plan is unchanged for the list and strictly narrower for the count

`EXPLAIN QUERY PLAN`, captured before and after against a corpus rebuilt by
`pnpm run corpus:build --db <dir> --memories 50000 --sessions 50000 --relations 43000 --prompts 50000 --seed 1`
(50 000 memories / 10 002 superseded, 43 000 relations / 10 822 pending), for both the
`project` and the `global` shape of `endpointsInScope`:

| read                  | before                                                                                                                                                                      | after                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `listPendingInScope`  | `SEARCH memory_relations USING INDEX memory_relations_status_created_idx (status=? AND created_at<?)` → `SEARCH ms/mt USING INDEX sqlite_autoindex_memory_1 (id=?)`         | identical, both scope shapes                                                                                                       |
| `countPendingInScope` | `SEARCH ms USING INDEX memory_type_in_scope_idx (scope=? AND project_id=?)` → `SEARCH memory_relations USING INDEX memory_relations_source_status_idx` → `SEARCH mt (id=?)` | leading index becomes `memory_scope_project_status_created_idx (scope=? AND project_id=? AND status=?)`; remaining steps identical |

No plan on either read gained a `SCAN` or a `USE TEMP B-TREE`. The list plan does not
change at all. The count's driving index is replaced by one that strictly contains it
plus the `status` column the new conjunct reads, so the outer loop visits fewer rows.
No index is added: both indexes already exist.

Wall-clock, **isolated statement** (200 iterations, 20 warm-up, one process per corpus;
read-only connection with the runtime pragmas), and **the `memory.context` handler
end-to-end** (50 iterations) — two different instruments, never mixed in one row:

| corpus | instrument                      | before   | after    |
| ------ | ------------------------------- | -------- | -------- |
| 1k     | `listPendingInScope` / project  | 0.306 ms | 0.245 ms |
| 1k     | `countPendingInScope` / global  | 0.139 ms | 0.146 ms |
| 20k    | `listPendingInScope` / project  | 0.214 ms | 0.292 ms |
| 20k    | `countPendingInScope` / global  | 1.986 ms | 1.390 ms |
| 50k    | `listPendingInScope` / project  | 0.284 ms | 0.284 ms |
| 50k    | `listPendingInScope` / global   | 0.222 ms | 0.196 ms |
| 50k    | `countPendingInScope` / project | 6.972 ms | 5.388 ms |
| 50k    | `countPendingInScope` / global  | 6.399 ms | 4.784 ms |
| 1k     | `memory.context` end-to-end     | 7.9 ms   | 6.7 ms   |
| 20k    | `memory.context` end-to-end     | 52.4 ms  | 46.2 ms  |
| 50k    | `memory.context` end-to-end     | 124.2 ms | 123.2 ms |

The list read is flat in corpus size on both sides (it is `LIMIT`-bounded off an
ordered index) and its sub-millisecond differences are run-to-run noise at this
resolution — no claim is made from them. The count read is the only one that grows,
and it gets faster, because it now counts fewer rows through a narrower index. The
end-to-end figure is what a user waits on and it does not regress.

The control that makes these numbers non-vacuous: the same probe reported
`memory.context` page = 5 and `pendingJudgmentsTotal` = 26 / 747 / 1838 before and
18 / 480 / 1147 after, at 1k / 20k / 50k. Both sides are non-empty, and the drop is
the retired-endpoint population the change removes (37.6% of the global pending queue
at 50k, against 33% in the reported deployment).

## Risks / Trade-offs

- [Risk] The predicate changes the query plan on a read that runs on every `memory.context`, and no measurement exists → Mitigation: capture `EXPLAIN QUERY PLAN` before and after for both methods, as a task, at the sizes the volumetric harness builds. The joins already exist and the new conjunct is an equality on a joined table's column, so a plan change is not expected — but "not expected" is not evidence, which is why it is a task and not a claim in the spec.
- [Risk] A future contributor rewrites `countPendingInScope` as an arithmetic difference, following the pattern `data-access` publishes for `relations.adminCountWithFilters` → Mitigation: the `data-access` delta records that this count now depends on a column no table-level difference can see, and the capability's existing scenario "A count rewrite's supporting schema fact changes" already makes re-verification mandatory.
- [Trade-off] Rows stay `pending` and invisible for at least 14 days → Accepted (D3): they are journal rows in a table the operator can see, and the alternative is a write on the save path this change deliberately avoids. "The sweep closes them" is bounded harder than the deadline suggests, and the arithmetic belongs here rather than in a bare claim: `ORPHAN_BATCH = 50` (`apps/server/src/consolidation/runner.ts:68`) per scope per run, throttled by `recentlySwept` to `DEFAULT_MIN_INTERVAL_MS = 24 * 3_600_000` (`:67`), so the drain ceiling is 50 rows per scope per day against a creation rate of up to `CANDIDATES_PER_SAVE_MAX_DEFAULT = 5` per save (`apps/server/src/config.ts:47`). Roughly ten unjudged saves a day in one scope saturate it. The SWEEP's ceiling is pre-existing and this change neither raises nor lowers it — it withholds nothing the sweep could otherwise have reached. But the honest accounting is that these rows had a SECOND drain before this change and no longer do: being older than the row that superseded them, they sorted to the HEAD of `pendingJudgments[]`, so an agent saw them first and could close them with `memory.judge({relation:'related'})`, which still succeeds today. That is precisely the waste #298 reports — but it was also a drain, and withholding removes it. So the change trades an agent spending fresh-context slots on dead pairs for those pairs draining at 50/scope/day instead of at agent rate. That is the right trade at the reported scale (30 pendings) and the wrong one to leave unbounded, which is why the deferred write-an-`orphaned`-row-at-supersede-time alternative is what would actually bound the population: it removes rows at creation rate. Tracked as the follow-up, not as a solved problem.
- [Trade-off] Two agent-facing surfaces now disagree: `memory.context` reports the withheld pair as absent while `memory.get`/`memory.search` still annotate it, `judgmentId` included, and a non-`supersedes` verdict on that handle still succeeds. Measured through the handlers, with the supersede confirmed as a control: `pendingJudgmentsTotal: 0` alongside `{"kind":"pending_conflict","judgmentId":"01KYQ…","status":"pending"}` from `memory.get`, and `memory.judge({relation:'related'})` returning `status: judged`. → Accepted, and deliberately NOT closed: `toOrderedAnnotation` (`apps/server/src/services/relations.ts:594`) is the only projection that still emits the `judgmentId`, so suppressing it too would leave no MCP path to the handle and breach `mcp-api/spec.md:2194`, which requires `not_conflict`, `conflicts_with`, `duplicate`, `related`, `compatible` and `scoped` to stay closable when an endpoint has been retired. The divergence is pinned by a scenario rather than hidden, on the same terms as D5's doctor/stats divergence. What the change removes is the queue slot, not the reachability.
- [Risk] `pendingJudgmentsTotal` can now decrease without any judgment being made (a `topic_key` save retires an endpoint and the total drops) → Mitigation: this is already true of the field for other reasons (`memory.archive` on an endpoint, the sweep's own orphaning), and the specified meaning is "queue depth now", not a monotone counter. Called out in the spec text so it is not read as a bug later.
- [Risk] An existing test depends on a pending pair whose endpoint is retired → Mitigation: the current fixtures build pendings between two freshly saved `active` memories (`apps/server/src/mcp/context-pending-judgments.test.ts::seedPending`), so none is expected to red; if one does, that is a finding to report before proceeding rather than a fixture to adjust.

## Migration Plan

None required, and nothing to invalidate.

- No schema change, no migration file, no boot-time work. First boot after upgrade behaves identically to any later one: the filter is evaluated per read.
- **Existing installations**: the effect on a populated database is immediate and downward — every retired-endpoint pending disappears from `pendingJudgments[]` and stops counting toward `pendingJudgmentsTotal` / `memory.stats` on the first call after upgrade. In the reported deployment that would have been 10 of 30 rows. No row is modified, so the operator's `/dashboard/judgments` view is byte-identical before and after.
- **Derived data** (`memory_fts`, `memory_vec`, the three entity tables) is untouched — nothing needs regenerating.
- **Rollback** is reverting the commit. The previously-hidden rows reappear; no state was written that a rollback would strand.

## Open Questions

- Should the deferred `stale` facet on `/dashboard/judgments` (#298) be a `status` filter value or a separate column/badge on the existing `pending` rows? Not settled, and deliberately not settled here — it is a dashboard-presentation decision that wants the operator's view of the real corpus, and this change gives the operator nothing new to look at. Default if nobody revisits: leave `/dashboard/judgments` exactly as it is; the rows remain visible and orphanable today.
- No blocking questions. The auto-orphan-at-supersede design (D3's rejected alternative) is a live follow-up rather than an open question — it has a clear shape and a clear reason to be a separate change.
