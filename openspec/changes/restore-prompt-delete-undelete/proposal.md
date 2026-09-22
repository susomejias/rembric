## Why

The Next.js dashboard migration dropped the prompt library's two operator verbs. `apps/web/src/app/dashboard/prompts/page.tsx` renders the prompts as a read-only table, while the retired `apps/server` view (`c64934f569b9f909d2131cde13b4e3d85ad583b5`, `apps/server/src/dashboard/prompts.ts`) rendered a per-row `Delete` form behind the reversible-confirmation dialog and an `Undelete` form on rows shown under `?include_deleted=1`. The dashboard spec already requires both (`openspec/specs/dashboard/spec.md`, "The dashboard MUST surface a prompts list view at `/dashboard/prompts`"); the rendered surface no longer satisfies it, so an operator has no way to soft-delete a captured prompt or restore one. The service methods (`PromptsService.softDelete` / `undelete`, `packages/core/src/services/prompts.ts`) survived the migration intact and are unchanged by this change.

## What Changes

- Add two Server Actions to the prompts page — `prompt.delete` and `prompt.undelete` — following the mechanism every other dashboard list already uses: `guardAction(formData, <form name>)` (session → admin scope → CSRF bound to that form name), `guardFailure` for the refused outcome, `ActionForm` + `CsrfField` for the submission, and `ConfirmSubmit` (`tone="warn"`) for the confirmation gate.
- Render an `actions` column: a live row offers `Delete` (confirmation-gated, `DELETE PROMPT`, warn tone because `Undelete` brings the row back) and a soft-deleted row — visible under `?include_deleted=1` — offers `Undelete` instead. Undelete is not confirmation-gated, matching the baseline and the reversible-verb rule.
- Redirect to `/dashboard/prompts?deleted=<id>` and `/dashboard/prompts?undeleted=<id>`, and flash the baseline wording above the table (`Prompt <code>…</code> soft-deleted.` with the link to the deleted view, and `Prompt <code>…</code> restored.`).
- Preserve the service contract exactly: `softDelete` sets `deleted_at`, `undelete` clears it, both are idempotent no-ops on a row already in the target state, and both refuse an unknown id with `prompt_not_found` (surfaced as the form's error, not a redirect).
- Restate the prompts-list requirement without the retired `data-confirm` / `#rbr-confirm` mechanism: the tone, sentence and label are component props now, per the destructive-actions requirement.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: the prompts list view renders the per-row `Delete` (warn-confirmed) and `Undelete` controls and their Server Actions, with authorization, reversible state transition and idempotence spelled out.

## Impact

- `apps/web/src/app/dashboard/prompts/page.tsx`: imports `DomainError`, `redirect`, `ActionForm`/`ActionState`, `ConfirmSubmit`, `CsrfField`, `Flash`, `Button`, `guardAction`/`guardFailure`, `singleParam`; adds the `DELETE_FORM`/`UNDELETE_FORM` constants, the `deletePrompt`/`undeletePrompt` actions, a `readField` helper, the flash block, an `actions` column header/cell and the `PromptActions` component.
- `apps/web/src/test/dashboard/prompts.test.tsx`: row-action wiring tests (Delete present and dialog-gated, Undelete only on deleted rows and ungated, CSRF/id fields, both flashes) plus the deleted-fixture rows moved to the newest `created_at` so they land in the rendered page slice.
- `apps/web/src/test/dashboard/prompts-actions.test.tsx` (new): the two actions driven through the real guard against a migrated SQLite fixture — anonymous, missing-CSRF, cross-form-CSRF and non-admin refusals; soft-delete/restore round trip; both idempotence cases; unknown-id error.
- `openspec/changes/restore-prompt-delete-undelete/`: this change.
- No service, repository, schema, migration, dependency or plugin change. The append-only invariant is untouched: `softDelete` only flips `deleted_at`, which is the recorded lifecycle.
