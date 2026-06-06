# Design — declutter-table-id-columns

## Context

Dashboard tables render a `shortId(...)` column that exists for one historical reason: it was the cell carrying the real `<a>` to the row's detail page (see the comment at `styles/core/content.css` — "links inside tables render in lime so the ID column feels clickable"). Whole-row navigation was later added via the `ROW_LINK` inline script (`templates.ts`): any `<tr data-href>` navigates on click, bailing out when the click lands on an interactive element (a, button, input, select, textarea, label, form).

The result today is two navigation mechanisms stacked on top of each other, with the id column serving as the anchor host even where another cell (session title) already carries an identical link. Tables that never had a detail page (projects, prompts, ops) render the id as plain text — pure noise.

Current inventory:

| Table                             | `data-href` | id cell role                          |
| --------------------------------- | ----------- | ------------------------------------- |
| Sessions list (visible + deleted) | yes         | redundant link (title cell links too) |
| Memories list                     | yes         | only real `<a>` in row                |
| Consolidation runs                | yes         | only real `<a>` in row                |
| Session detail → Memories         | yes         | only real `<a>` in row                |
| Memory detail → Predecessors      | yes         | only real `<a>` in row                |
| Judgments list                    | **no**      | only path to detail page              |
| Projects (active + archived)      | no          | plain text, no detail page            |
| Prompts list                      | no          | plain text, no detail page            |
| Session detail → Prompts          | no          | plain text, no detail page            |
| Run detail → Ops                  | no          | plain text, no detail page            |

## Goals / Non-Goals

**Goals:**

- Remove the id column from all ten tables.
- Preserve exactly one real `<a href>` per whole-row-clickable row (cmd-click, middle-click, keyboard, a11y).
- Make judgments rows whole-row clickable, consistent with the other navigable lists.
- Update the four dashboard spec requirements that mandate id columns.

**Non-Goals:**

- No change to the `ROW_LINK` script, the `data-confirm` modal, or any design token.
- No change to memory shortId links inside consolidation op cells (`affected` / `created`) — those are functional cross-navigation, not row identity.
- No detail pages for prompts, projects, or ops.
- No change to `shortId()` itself — it remains used in page titles (`Memory {shortId}`), viewHead headings, and op cells.

## Decisions

### D1 — Every clickable row keeps one real `<a>`, hosted on the row's semantic cell

`data-href` is JS-only (`window.location.href`); without a real anchor the row loses open-in-new-tab, middle-click, keyboard focus, and link semantics. The anchor relocates to the cell an operator naturally reads as the row's identity:

| Table                        | Anchor host after change                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Sessions list                | `title` cell (already the anchor — id column simply dropped)                      |
| Memories list                | `content` cell (truncated content wraps in `<a href="/dashboard/memories/{id}">`) |
| Session detail → Memories    | `content` cell                                                                    |
| Memory detail → Predecessors | `content` cell                                                                    |
| Consolidation runs           | `started` cell (the `<a>` wraps the `formatTs(...)` `<time>` output)              |
| Judgments list               | `created` cell (see D2)                                                           |

Alternatives considered:

- _Rely on `data-href` alone, no anchor_ — rejected: breaks cmd-click/middle-click/keyboard and screen-reader link semantics.
- _Wrap the `<tr>` in an `<a>`_ — rejected: invalid HTML (anchors cannot wrap table rows).
- _Keep a narrow id column as link-host_ — rejected: that is the noise this change removes.

Content-cell anchors render lime via the existing `.main table a` rule — same treatment the judgments `source → target` cells and session titles already use. No new CSS.

### D2 — Judgments rows get `data-href`; the detail anchor lives on the `created` cell (option B)

Judgments is the only navigable list whose rows are not clickable; the id cell is the sole path to `/dashboard/judgments/:id`. The row gains `data-href="/dashboard/judgments/{id}"` and the id column is removed.

The anchor cannot live on `source → target` (already occupied by two memory anchors) and should not wrap the status/verdict pills (pills read as state badges, and lime link styling fights the pill styling). The `created` timestamp cell is the only non-interactive cell left, so the real `<a>` wraps the `formatTs(...)` output there — mirroring the consolidation-runs treatment in D1.

The `ROW_LINK` bail-out keeps the memory anchors and the `Mark orphaned` form fully functional inside a clickable row (identical to how sessions rows host Delete/Abandon forms today).

Alternative considered: _keep judgments as-is (option A, id column stays)_ — rejected by the operator: inconsistent with every other navigable list, and `source → target` is the cell that most benefits from the recovered width.

### D3 — Tables without detail pages just drop the column

Projects, prompts list, session-detail prompts, and the ops table render ids as plain text. Removal with no compensation: actions already carry the full id in their form `action` URLs, and ops cross-link memories through `affected` / `created`. Empty-state `colspan` values decrement accordingly (judgments 7→6; others where present).

### D4 — Sessions list sorts active-first via a SQL `CASE` expression

The list query (`sessions.ts` — `orderBy(desc(agentSessions.startedAt))`) gains a leading sort key: `CASE WHEN status = 'active' THEN 0 ELSE 1 END`, keeping `started_at DESC` as the secondary key. Active sessions are the rows an operator acts on (Abandon, watch progress); burying them under ended ones once history grows defeats the list.

Alternatives considered:

- _Sort in JS after fetch_ — rejected: pagination is SQL-side (`LIMIT`/`OFFSET`); a JS sort would only reorder within the fetched page, so an active session on page 2 would still hide behind page 1's ended rows.
- _Separate "Active" table above the main list_ (like projects' active/archived split) — rejected: heavier change, duplicates headers, and active sessions are usually few; a sort suffices.

The deleted-rows table (under `?include_deleted=1`) keeps plain `started_at DESC` — soft-deleted rows are an audit view, not a work queue.

### D5 — Spec deltas modify the existing `dashboard` capability; no new capability

Four requirements change (sessions list columns + ordering, prompts list columns, session-detail prompts columns, judgments queue + its id-anchor scenario). Per project convention, each delta carries the full updated requirement text so the archive sync resolves cleanly. The memories, consolidation, and projects requirements do not enumerate columns, so no delta is needed for them.

## Risks / Trade-offs

- [Risk] Operators occasionally copy ids from list views (e.g. to query the DB or hit admin endpoints) → Mitigation: every detail page keeps the full/short id in its heading (`Memory {shortId}`, `Run {shortId}`, `Judgment {shortId}`), and list rows still expose the id in the anchor `href`. One extra click for a rare workflow.
- [Risk] `dashboard-e2e.test.ts` asserts an exact multiline anchor snippet for the judgments id link (line ~533) and the spec scenario "Judgments list id column links to the detail page" → Mitigation: both are updated in the same change; the looser assertions (`href="/dashboard/judgments/{id}"` present in list body) survive unchanged because the anchor relocates rather than disappears.
- [Trade-off] Timestamp cells in runs/judgments become lime links, slightly louder than the muted grey they render today → Accepted because it is the existing visual grammar for "this navigates" (`.main table a`), and it replaces a whole dead column.
- [Trade-off] Rows without `title`/`content` worth reading (e.g. a memory with very short content) lose the always-uniform-width id anchor → Accepted because content is never empty for these rows and `data-href` covers the whole row anyway.

## Migration Plan

Presentation-only; no DB, API, or plugin changes. Ships in one PR: templates + CSS comment + spec deltas + test updates. Rollback = revert the commit.

## Open Questions

(none)
