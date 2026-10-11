---
description: Show recent memory context for this project.
---

Call `memory.context()` and render results compactly (id, type, 1-line excerpt).

If the response includes `needsReview[]` (active memories past their re-verification shelf life) or `pendingJudgments[]` (aged unresolved conflicts), list them under a short "Needs attention" heading: for `needsReview`, confirm with `memory.confirm_batch({ ids: [id] })` if still true, supersede with `memory.save({topic_key})` if changed; for `pendingJudgments`, close each with `memory.judge_batch({ judgments: [{ judgmentId, relation }] })`. For a dated work recap, call `memory.session_get_batch({ from, to, limit: 20, offset: 0 })` for full current summaries, or `memory.get_batch` with the same dates for memories created then. Repeat with `offset: nextOffset` until null; inspect errors alongside valid results. Use dates or IDs, never both; mutations do not select by dates.
