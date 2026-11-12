# Agent-driven N-to-1 memory merge (`memory.merge`) — issue #450

Objective: an MCP tool that merges several active memories into one successor through preview → confirm, journaled as one undoable `merge` op.
Branch: `feat/memory-merge` (worktree `rembric-worktrees/feat-450-memory-merge`). Delivery: single PR, one commit per work unit. Test runner: vitest (`pnpm vitest run <file>`, `pnpm test`).

## Specs

- S1 (issue) "Add an agent-driven merge tool with a **two-phase, preview-then-confirm** contract. A merge supersedes several active memories at once, so it must never happen on a single unreviewed call." Decision L2: ONE tool `memory.merge`; without `fingerprint` it is a preview, with `fingerprint` it confirms.
- S2 (issue) "**Phase 1: preview (no writes).** The input is the ids to merge, plus the successor's `title`, `content`, `type`, optional `topic_key` and tags. The server validates and returns: the resolved originals (bounded previews); the successor exactly as it would be stored; warnings, for example two different `topic_key`s, a `needs_review` original, or pending judgments touching an original; an opaque `fingerprint` over the inputs **and** the current state of every original." Decision L2: fingerprint = sha256 over normalized inputs + each original's id/status/type/title/content/tags/topic_key/replaces + warnings; excludes `last_seen_at`; no HMAC.
- S3 (issue) "**Phase 2: confirm.** The same arguments plus the `fingerprint`. In one transaction the server: inserts the successor with `replaces = [ids…]`; flips every original to `superseded`; carries over confirmations and relations as the spec decides; journals a single `merge` op with `affected_ids` and `created_id`." Decisions L2: confirmations are NOT carried over (successor starts fresh); NO new relation rows are written and existing relations of the originals are NOT copied; pending judgments touching an original are a preview warning and stay as they are. Each merge opens one `consolidation_runs` row with scope `maintenance` (same path as `memory.archive`; a `project:<id>` run would trip the sweep throttle `recentRunExists`) holding the single op.
- S4 (issue) "If any original changed since the preview, the fingerprint no longer matches. The server then returns a fresh preview and writes nothing; it never silently merges against a different state." Decision L2: returned as an MCP error (`isError: true`) with code `fingerprint_mismatch` and the fresh preview (with its new fingerprint) in the payload.
- S5 (issue) "Every id must be `active` and inside the connection's effective scope. Cross-scope ids are `not_found`, as everywhere else." Non-active ids → `conflict` naming them. Both phases require write access.
- S6 (issue) "A named maximum N per merge." Decision L2: N = 10 (= `PREDECESSOR_CAP`), minimum 2, ids distinct.
- S7 (issue) "The successor goes through the normal save path: candidate detection, entity extraction, embedding, and secret redaction once that lands." Implementation: extract the post-commit half of `saveMemoryWithCandidates` into a shared helper reused by merge.
- S8 (issue) "`topic_key` rules: if the originals share one key, the successor takes it; if they hold different keys, the merge is refused unless the caller names the surviving key explicitly." Decisions L2: omitted key + exactly one distinct non-null key among originals → inherited; a caller-named key held by an active memory OUTSIDE `ids` → refused with `conflict` naming the occupant.
- S9 (acceptance) "Confirm without a matching fingerprint writes nothing. A control with the matching fingerprint commits."
- S10 (acceptance) "After a merge, `memory.get_batch` on any original shows it `superseded`, with the successor discoverable through the existing history read."
- S11 (acceptance) "Undoing the `merge` op from the dashboard restores every original to `active` and archives the successor, reusing the existing undo path, with a test that exercises it end to end." Includes fixing `undoOp` to archive the successor BEFORE reactivating originals (today a successor that inherited a `topic_key` occupies the slot and the original is skipped).
- S12 (acceptance) "The tool description steers toward previewing and showing the plan to the user before confirming."

## Tasks

| ID  | Specs                    | Route  | Status                                         | Commit   |
| --- | ------------------------ | ------ | ---------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| T1  | S1-S12                   | inline | done                                           | 084edb43 | OpenSpec change `add-memory-merge` (proposal, design, delta specs `mcp-api` + `consolidation`, tasks) |
| T2  | S11                      | inline | done: RED (original skipped) then GREEN        | e7563e2f | `undoOp` merge ordering fix + regression test                                                         |
| T3  | S2-S8                    | inline | done: 20 tests, 14/14 mutations caught         | 11faee79 | `MemoryService` merge preview/commit + journal + tests                                                |
| T4  | S1, S4, S7, S9, S10, S12 | inline | done: wire tests, 4/4 handler mutations caught | 6ca3149d | `memory.merge` MCP tool, catalog wiring, docs, e2e undo test                                          |

Route evidence: no Writer trigger — units depend on each other (T4 on T3), so they are not independent parallel units.

## Log

- L1 (2026-11-12, user): "necesito implementar esta issue en un nuevo worktree: https://github.com/susomejias/rembric/issues/450" — then "hay que hacer un grill-me supongo antes porque habrá ciertas dudas".
- L2 (2026-11-12, grill-me decisions): one tool `memory.merge` (fingerprint presence = confirm); N max 10; confirmations not carried over; no new relations and existing ones not copied (pending → preview warning); caller-named `topic_key` held outside the set → refuse; fingerprint mismatch → error `fingerprint_mismatch` with fresh preview; single PR with per-unit commits.
- L3: found `undoOp` reactivates originals before archiving the successor (`packages/core/src/consolidation/operations.ts`), so an original sharing the successor's `topic_key` is skipped → fixed in T2. Engram mirror: pending (Engram tools unavailable in this session).
- L4: run scope switched from `project:<id>` to `maintenance` — a `project:<id>` run satisfies the sweep throttle `recentRunExists` and would skip that project's next sweep (pinned by a test).
- L5 (user, 2026-11-12): "revisa si hay que actualizar o implementar algo en los plugins" → verified: no client keeps a tool allowlist (all discover via `tools/list`; Pi maps `.`→`_` dynamically); only prose mentions tools. No plugin change, to avoid an unrequested plugin release.
- L6: RDD off (global); native review not applicable.
- L7: independent verifier: no blockers; its runtime probes hung on an open MCP client handle, so its verdicts are static. Advisory A1 reproduced (RED): a second pending judgment on an already-warned original did not change the fingerprint — fixed by hashing each warning's message (it carries the count). A2: merge validation errors said `memory.save:` — `validateSaveFields` now takes the op name (default `memory.save`, so save messages are unchanged). A4 (undo archives an already-superseded successor) predates this change at e555921a: advisory only.
