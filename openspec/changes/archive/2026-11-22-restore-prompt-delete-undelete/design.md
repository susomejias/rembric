## Decisions

### Undelete replaces Delete on a soft-deleted row, rather than being additive

- **Chosen:** a row renders either `Delete` (live) or `Undelete` (soft-deleted), never both.
- **Alternative considered:** render `Delete` on every row and add `Undelete` to deleted rows, reading the spec's "SHALL additionally render an `Undelete` form" literally.
- **Why:** the baseline renderer chose one verb per row (`apps/server/src/dashboard/prompts.ts` builds `actionForm` as `isDeleted ? undeleteForm : deleteForm`), and every migrated list that has this pair does the same (`sessions/page.tsx` renders Abandon/Delete on a live row and Undelete on a deleted one). A `Delete` on an already-deleted row is a no-op that still redirects; presenting it would ask the operator to confirm a state change that cannot happen. The spec sentence is read as "the rows shown under `?include_deleted=1` gain the `Undelete` affordance", and the MODIFIED requirement in this change states the live/deleted split explicitly so the ambiguity is closed.

### The confirmation gate is `ConfirmSubmit`'s component props, not `data-confirm` attributes

- **Chosen:** `<ConfirmSubmit tone="warn" title description confirmLabel>` wrapping the trigger `Button`.
- **Alternative considered:** restore the retired `data-confirm` / `data-confirm-label` / `data-confirm-tone` attributes and the `#rbr-confirm` HTMX dialog.
- **Why:** the destructive-actions requirement retires that mechanism ("The `data-confirm`, `data-confirm-label` and `data-confirm-tone` HTML attributes, the `form[data-confirm]` selector binding and the `htmx:afterSwap` rebind are retired with the stack that needed them; the three properties above are preserved as component props"). The prompts requirement's scenarios still name the retired attributes, which is stale text from the same row actions; the MODIFIED requirement replaces it with the component-prop phrasing.
- **Evidence limit:** `warn` is a declared prop on a client component whose `AlertDialogContent` renders only once the dialog opens, so it is not observable in the server-rendered HTML. The rendered surface proves the gate exists (the Delete button carries `data-slot="alert-dialog-trigger"` and `type="button"`); the tone itself is verified by reading the call site.

### Redirect after success, returned `ActionState` on refusal

- **Chosen:** mirror `sessions/page.tsx` exactly — a successful mutation calls `redirect()` outside the `try`, so the framework's control-flow error is not caught; a refused guard or a `DomainError` returns `{ error }`, which `ActionForm` renders as the form's `Flash`.
- **Alternative considered:** the baseline's `domainErrorPage` with a 404/400 status (an `prompt_not_found` for a stale id).
- **Why:** a Server Action cannot set a response status, so a status page is not available on this surface; the established Next dashboard pattern is the returned error. The redirect target keeps the baseline's query-string flash contract (`?deleted=` / `?undeleted=`).

## Risks / Trade-offs

- [Risk] The redirect drops any active filters (project, agent, session, search), because the baseline redirect did too and the flash lives on the unfiltered URL. → Accepted because it is the baseline behavior and the sibling sessions list has the same shape; changing it would be a separate UX decision.
- [Risk] The `?deleted=` / `?undeleted=` param is round-tripped by `promptsQuery` into pager links, so the flash reappears when paging. → Accepted because `sessionsQuery` behaves identically and `prompts/filters.ts` is outside this change's scope.
- [Trade-off] The new action tests duplicate the temp-dir fixture setup from `dashboard-mutations.test.ts` instead of sharing it. → Accepted because the guard needs the app's own cached `SessionsService` over `REMBRIC_DATA_DIR`, and extracting that fixture is a change to a test file outside this change's edit surface.
