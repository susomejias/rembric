## Context

`memory.get_session` shipped in server-v0.21.7 as the on-demand full-summary fetch tool. The session-lifecycle tools are `memory.session_start` / `memory.session_end` / `memory.session_summary` — a `memory.session_*` family. `memory.get_session` is the odd one out. This change renames it to `memory.session_get`.

## Goals / Non-Goals

**Goals:**

- One consistent `memory.session_*` family.
- Internal symbol names follow the family convention so the codebase reads uniformly.
- The canonical `sessions` spec, tests, doc-comments, and docs all reflect the final name.

**Non-Goals:**

- Any behavior change (args, response, scope-resolution, `not_found` semantics stay identical).
- A migration or data change (none — pure tool-surface rename).
- Touching the unrelated dashboard `getSession(c)` cookie-session resolver.

## Decisions

**Decision 1 — Treat as a non-breaking naming correction, not a breaking change.**
The tool was released ~1 day ago, has no adopters, and no plugin client references it (verified by grep over `apps/plugin/`). MCP tool names are discovered at runtime via `tools/list`, not pinned in client config. Commit as a normal `feat(server)` (no `!`, no `BREAKING CHANGE` footer); in 0.x this is an ordinary feature bump.

- _Alternative — `feat(server)!` / BREAKING CHANGE:_ rejected; overstates impact for a pre-adoption rename and would imply a contract break that doesn't exist in practice.

**Decision 2 — Spec delta as REMOVED + ADDED, not RENAMED.**
The requirement's header AND body both embed the tool name. OpenSpec `RENAMED` is "name only" (won't update the body); `MODIFIED` matches on the existing header (can't change it). REMOVED (with Reason + Migration documenting the rename) + ADDED (new name, full body + scenarios) is the only operation pair that updates header and body together and syncs the canonical spec cleanly.

- _Alternative — RENAMED + MODIFIED:_ rejected; applying a body MODIFY against a just-RENAMED header within one archive sync is fragile.

**Decision 3 — Surgical rename; never touch dashboard `getSession`.**
`getSession(c: Context)` is a local cookie-session resolver duplicated across ~every `src/dashboard/*.ts` file — a completely separate symbol. A repo-wide `getSession` sed would corrupt the dashboard. The rename is confined to the wire string and the MCP-tool symbols in `apps/server/src/mcp/{server,sessions-tools}.ts` only; all other `getSession` occurrences are out of scope by construction.

**Decision 4 — Internal symbols mirror the `session_summary` precedent.**
`sessionGetSchema` / `handleSessionGet` / builder key `sessionGet`, matching `sessionSummarySchema` / `handleSessionSummary` / `sessionSummary`.

## Risks / Trade-offs

- **[Risk] A `getSession` sed corrupts the dashboard resolver** → Mitigated: rename is done with targeted edits in the two MCP files only; the spec/tests/docs use the fully-qualified wire string `memory.get_session` which is unambiguous.
- **[Trade-off] REMOVED+ADDED reads as remove-then-add rather than "rename"** → Accepted: the REMOVED `Reason`/`Migration` state the rename explicitly; the resulting canonical spec is correct and internally consistent, which matters more than the delta's prose shape.
- **[Risk] Stale `memory.get_session` left somewhere (docs/comments/tests)** → Mitigated: a final `grep -rn "get_session"` over the repo (excluding the dashboard `getSession(c)` and the historical CHANGELOG) must return zero before the change is done.

## Migration Plan

None at runtime. Code + spec + docs rename only. Rollback = revert the commit. The next release's CHANGELOG records the rename from the new `feat(server)` commit; `apps/server/CHANGELOG.md`'s 0.21.7 entry stays as historical record.
