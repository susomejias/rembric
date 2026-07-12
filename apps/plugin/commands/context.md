---
description: Show recent memory context for this project.
---

Call `memory.context()` and render results compactly (id, type, 1-line excerpt).

If the response includes `needsReview[]` (active memories past their re-verification shelf life) or `pendingJudgments[]` (aged unresolved conflicts), list them under a short "Needs attention" heading: for `needsReview`, confirm with `memory.confirm` if still true, supersede with `memory.save({topic_key})` if changed; for `pendingJudgments`, close each with `memory.judge`.
