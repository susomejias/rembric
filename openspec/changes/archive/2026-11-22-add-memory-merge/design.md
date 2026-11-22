## Context

Agents can collapse redundant memories only pairwise (`memory.judge_batch` supersedes, `topic_key` upserts). The storage model already carries the many-to-one shape: `memory.replaces` is an array, `merge` is a journaled op type, and `undoOp` reactivates a merge's `affected_ids` and archives its `created_id`. Nothing outside tests writes a `merge` op. Issue #450 asks for an agent-driven N-to-1 merge with a preview-then-confirm contract.

## Goals / Non-Goals

**Goals:** one reviewed decision merges up to 10 memories, journaled as one undoable `merge` op; a stale preview can never merge; the successor is indistinguishable from a normal save afterwards (embedding, candidates, entities).

**Non-Goals:** automatic or sweep-driven merges (the sweep still produces no `merge` ops); an MCP undo verb (undo stays operator-only, from the dashboard); plugin-side commands (clients discover the tool through `tools/list`).

## Decisions

- **D1: one tool, two phases.** `memory.merge` without `fingerprint` previews; with it, it confirms. The issue's own wording is "the same arguments plus the `fingerprint`", and a separate tool or a `mode` flag would only restate what the presence of `fingerprint` already says.
- **D2: fingerprint = sha256 over successor + originals' state + warnings; no HMAC.** It detects that the state changed, it does not authorize anything: write access is already checked on both phases. It excludes `last_seen_at`, because every read moves it, and a `get_batch` between preview and confirm would otherwise always mismatch. It includes the warnings, so a pending judgment created after the preview invalidates it even though no original row changed.
- **D3: the mismatch is an error carrying the fresh preview.** `isError: true` with code `fingerprint_mismatch` cannot be mistaken for success by an agent that only checks `isError`. The payload carries the fresh preview, so the agent can show the new plan without a second call. Error results skip output-schema validation (MCP SDK), so the preview lives in the error JSON only.
- **D4: N = 10 = `PREDECESSOR_CAP`.** The successor's history read then lists every original without truncation.
- **D5: no confirmation carry-over, no relation writes or copies.** The successor is new text nobody has affirmed. Judgments on an original were made against that original's text. Pending ones are warned about and stay; the deadline sweep orphans them as usual. The merge stays one journal op plus `replaces`, so undo needs nothing beyond the existing path. Supersede-by-judge and `topic_key` upserts also carry no confirmations.
- **D6: `topic_key`.** Inherit the single distinct key; refuse ambiguity; refuse a named key whose holder is outside `ids`, because the save path would otherwise supersede it silently and outside `affected_ids`, where undo could never restore it. The originals are flipped to `superseded` BEFORE the successor is inserted, so the UNIQUE active-topic index never sees two active rows.
- **D7: journal through the maintenance run path.** The op goes into its own `consolidation_runs` row with `scope = 'maintenance'`, the path `memory.archive` already uses. The sweep throttles on `recentRunExists('project:<id>')`, so a `project:<id>` run would have silently skipped that project's next sweep.
- **D8: undo archives the successor first.** `undoOp` used to reactivate originals while the successor was still active. An original sharing the successor's inherited `topic_key` then found its slot "occupied" by the successor and was skipped. Archiving first frees the slot. Historical merges without topic keys behave exactly as before.
- **D9: one save pipeline.** `validateSaveFields` is shared by `saveWithTopicKey` and the merge plan. The post-commit half of `saveMemoryWithCandidates` (embedding, candidates, entity linking) becomes a helper both call, so redaction or any later save step lands in one place.

## Risks / Trade-offs

- A merge whose originals carry many pending judgments leaves them pending against superseded rows until the deadline sweep orphans them. This is accepted and surfaced as a warning (D5).
- The spec's "Failure mid-merge … a failed op SHALL be logged" scenario predates this change, and no producer implements `failed` ops. A failing merge rolls back entirely and surfaces the error to the caller, which matches the rest of the agent write path.
