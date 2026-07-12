## Why

The just-shipped `close-session-context-pollution-gap` change (commit `45fe9f0`, still unarchived) tightened the shared `sessionHasContentSql` predicate so a session's `summary` only counts as "content" when it's curated (`summary_final = 1`). That predicate is consumed identically by two very different consumers: `recentForContext` (what the agent sees via `memory.context.recentSessions`) and `countPurgeableEmpty`/`purgeEmpty` (what the consolidation sweep physically `DELETE`s after a 1-hour grace period). The tightening was correct and necessary for the first consumer — it fixed a real incident where raw transcript noise resurfaced in an agent's context. But sharing one bar means a session with a large, genuinely substantive raw transcript — real conversation happened, the agent simply never called `memory.session_summary` to curate it, a common occurrence confirmed via live testing today across all three clients — is now physically, irreversibly deleted exactly as if it had never contained anything at all. That is a materially different kind of harm (permanent data loss) from the one the tightening fixed (an agent seeing untrusted noise), and the two do not need the same bar.

## What Changes

- `sessionHasContentSql` gains a parameter (e.g. `requireCuratedSummary: boolean`) governing only clause 1 (the summary clause). `recentForContext` continues to pass `true` — **no change to `memory.context.recentSessions`'s behavior**. `countPurgeableEmpty`/`purgeEmpty` pass `false` — a session with _any_ summary text, curated or not, is no longer purge-eligible on that basis alone (reverting clause 1, for purge purposes only, to its pre-`45fe9f0` shape). Clauses 2–5 (title curation, anchored memory/prompts/confirmations) are unchanged and identical between both call sites.
- The manual purge-confirmation dialog on `/dashboard/maintenance` is reviewed and its copy corrected if it currently overclaims or underclaims what the sweep removes, now that the bar has changed.
- No change to the operator dashboard's own session list (`adminList`), which already shows every session regardless of this predicate and is unaffected either way.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sessions`: `sessionHasContent`'s single-predicate contract is amended so purge-eligibility and context-surfacing may apply different curation bars for the summary clause, while remaining one shared implementation (not two independently-maintained predicates).

## Impact

- `apps/server/src/db/repositories/agent-sessions-repository.ts` — the `sessionHasContentSql(alias)` helper (lines ~71-79) gains a second parameter governing clause 1; its three call sites (`recentForContext`, `countPurgeableEmpty`, `purgeEmpty`) are updated to pass the appropriate value. (Note: the still-unarchived `close-session-context-pollution-gap` change's spec text says this predicate lives in `apps/server/src/services/agent-sessions.ts` — the actually-shipped code places it in the repository file instead; this proposal targets the real location, and the location mismatch in the sibling change's spec text is a pre-existing drift this change does not attempt to fix.)
- `apps/server/src/services/agent-sessions.test.ts` — the existing test `"purges a session whose only content is a raw, uncurated summary (summary_final=0)"` currently asserts deletion; this change makes that assertion false for that exact case, so the test must be rewritten to assert survival, and a new test added asserting the case it used to cover (an entirely empty session — no summary at all) is still purged.
- `apps/server/src/dashboard/consolidation.ts` (or wherever the `/dashboard/maintenance` purge-confirmation copy lives) — review/correct dialog wording.
- `openspec/specs/sessions/spec.md` — requirement delta (see `specs/sessions/spec.md` in this change).
- Coordination note: `openspec/changes/close-session-context-pollution-gap/` is not yet archived; its own `sessionHasContent` requirement delta has not yet been synced into the canonical `openspec/specs/sessions/spec.md`, so this change's spec delta is written against the current, actually-shipped behavior (post-`45fe9f0`, pre-this-change) rather than against the stale canonical file. Archiving order between the two sibling changes should be resolved before either is archived, so the canonical spec ends up correct regardless of which archives first.
