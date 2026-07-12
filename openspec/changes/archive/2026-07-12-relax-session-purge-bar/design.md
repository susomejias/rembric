## Context

`sessionHasContentSql(alias)` (`apps/server/src/db/repositories/agent-sessions-repository.ts:71-79`) is a single SQL-fragment helper with five OR'd clauses, consumed by three call sites:

- `recentForContext` (positive form) — decides what `memory.context.recentSessions` surfaces to the agent.
- `countPurgeableEmpty` / `findPurgeableEmptyIds` (negated form, `NOT sessionHasContentSql(...)`) — decide what the consolidation sweep's `purgeByIds` physically `DELETE`s.

Clause 1 today is `summary IS NOT NULL AND summary_final = 1`, tightened from a bare `summary IS NOT NULL` earlier today (commit `45fe9f0`) specifically to stop uncurated raw transcript dumps from surfacing in the agent's context (a real incident: `<local-command-caveat>` noise resurfacing in a later session). That fix is correct and this change does not touch it for `recentForContext`.

The problem is that the same clause also governs `purgeEmpty`, so a session with a large, genuine raw transcript — real conversation happened, curation just never occurred, which is common (confirmed via live cross-client testing today) — is now physically deleted with no anchored memory/prompt/confirmation identically to a session that was truly empty from the start. Deletion is irreversible; context-surfacing is not. The two consumers do not need the same bar on this one clause.

## Goals / Non-Goals

**Goals:**

- Stop `purgeEmpty` from deleting sessions that have real (even if uncurated) summary content.
- Change nothing about `memory.context.recentSessions`'s behavior — the incident this clause originally fixed must stay fixed.
- Keep `sessionHasContentSql` as the single implementation both consumers share — no forked/duplicated SQL.

**Non-Goals:**

- Surfacing raw/uncurated sessions in `memory.context.recentSessions` in any form (considered during `/opsx:explore`, explicitly deferred by the user — a separate future change if ever pursued).
- Any change to the operator dashboard's own session list (`adminList`), which already ignores this predicate entirely and shows every session regardless.
- Revisiting clauses 2–5 (title curation, anchored memory/prompts/confirmations) — unchanged, identical between both consumers, exactly as today.

## Decisions

### 1. Parameterize the existing helper; do not fork it

`sessionHasContentSql(alias, opts?: { requireCuratedSummary?: boolean })` (default `true`, preserving today's behavior for any call site that doesn't pass the option explicitly). Clause 1 becomes:

```
requireCuratedSummary
  ? `${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1`
  : `${alias}.summary IS NOT NULL`
```

`recentForContext` passes `{ requireCuratedSummary: true }` (or omits the option, relying on the default — either is fine; passing it explicitly is more self-documenting and is the chosen approach so a future reader doesn't have to know the default). `countPurgeableEmpty` and `findPurgeableEmptyIds` pass `{ requireCuratedSummary: false }`. Clauses 2–5 are untouched, generated identically regardless of the option.

**Alternative considered**: two independent functions/SQL strings (`sessionIsContextWorthySql` / `sessionIsPurgeableSql`). Rejected — this is exactly the drift risk the original predicate's own doc comment warns against ("adding a new table that anchors to a session id... MUST update only this helper"); a future new clause (e.g. a hypothetical `tool_calls` table) would need updating in two places instead of one, silently reintroducing the "asymmetry IS the bug" class of problem the sibling change fixed for clause 1 specifically.

**Alternative considered**: relax clause 1 to require _some_ non-trivial content (e.g. a minimum length) rather than any non-null summary. Rejected — no evidence today's raw-summary content is ever junk short enough to warrant a length floor; the existing per-entry/per-transcript truncation logic in every client already bounds summary length, and introducing a new arbitrary threshold adds a tuning surface with no motivating failure mode.

### 2. No change needed to the purge-confirmation dialog copy

`apps/server/src/dashboard/consolidation.ts`'s `data-confirm` text ("Force a consolidation sweep across all scopes now? ... this also purges empty sessions — that purge is irreversible.") already says "empty sessions." Before this change, that phrase mildly overclaimed accuracy (it was also purging non-empty-but-uncurated sessions). After this change, it precisely describes what gets purged. No copy change required — verified by reading the current dialog text; recorded here so a reviewer doesn't wonder why the proposal's suggestion to check this wasn't acted on.

## Risks / Trade-offs

- **[Trade-off]** A session with a raw summary but genuinely garbage content (e.g. the exact `<local-command-caveat>` noise pattern from the original incident) now persists in the database indefinitely instead of being auto-cleaned. **Accepted because**: it was never reaching the agent's context either way (that fix is untouched), so the only cost is DB/dashboard clutter, which the operator can already address manually via the existing per-session `ABANDON`/`DELETE` dashboard actions — a materially smaller cost than irreversibly losing genuine content.
- **[Risk]** The existing test `"purges a session whose only content is a raw, uncurated summary (summary_final=0)"` (`apps/server/src/services/agent-sessions.test.ts`) currently pins the OLD (about-to-change) behavior as correct. **Mitigation**: task list rewrites this test to assert survival instead, and adds a new test confirming a session with `summary IS NULL` and no anchors is still purged (the actually-empty case, unaffected by this change).
- **[Risk]** This change's spec delta is written against current shipped behavior rather than the not-yet-archived sibling change's canonical spec text, since `close-session-context-pollution-gap` hasn't been archived yet. **Mitigation**: resolve archiving order between the two sibling changes before archiving either (see proposal.md's coordination note) — whichever archives first must produce a canonical `sessions/spec.md` that's correct after both are applied; this is a documentation-sequencing concern, not a code risk, since both changes' code is independent and non-conflicting.

## Migration Plan

1. Parameterize `sessionHasContentSql`; update the three call sites.
2. Rewrite the one existing test that pins the old behavior; add the new "truly empty is still purged" test.
3. No data migration, no schema change, no client/plugin changes — this is a server-only, single-file behavioral change.
4. Rollback is a plain revert; no persisted state depends on the new parameter (a session that would have been purged under the old bar simply continues to exist — reverting later just resumes purging it once it crosses the grace period again).

## Open Questions

- None outstanding — scope was deliberately narrowed during `/opsx:explore` to exactly this single-clause relaxation.
