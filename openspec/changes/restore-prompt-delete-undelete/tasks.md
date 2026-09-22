# Tasks

## 1. Restore the prompt actions on the prompts page

- [x] 1.1 Add `DELETE_FORM = 'prompt.delete'` and `UNDELETE_FORM = 'prompt.undelete'`, and export `deletePrompt` / `undeletePrompt` Server Actions on `apps/web/src/app/dashboard/prompts/page.tsx`, each calling `guardAction(formData, <form name>)`, returning `guardFailure` on refusal, calling `guard.services.prompts.softDelete` / `undelete` with `adminBypass`, and `redirect()`ing outside the `try`.
- [x] 1.2 Surface an unknown prompt id as `{ error }` on `DomainError` instead of redirecting, matching `sessions/page.tsx`.
- [x] 1.3 Render the `actions` column: `PromptActions` gives a live row the `Delete` `ConfirmSubmit` (`tone="warn"`, label `DELETE PROMPT`) and a soft-deleted row the bare `Undelete` submit; both carry `CsrfField` and the hidden row id.
- [x] 1.4 Read `deleted` / `undeleted` from `searchParams` and flash the baseline wording above the table.
- [x] 1.5 `pnpm --filter @rembric/web exec vitest run src/test/dashboard/` passes with the new tests included.

## 2. Prove the restored contract

- [x] 2.1 `apps/web/src/test/dashboard/prompts.test.tsx` covers: Delete on live rows and its dialog trigger (`data-slot="alert-dialog-trigger"`, `type="button"`), Undelete only under `?include_deleted=1` and ungated (`type="submit"`), the `actions` header, the CSRF/id fields, and both flash strings.
- [x] 2.2 `apps/web/src/test/dashboard/prompts-actions.test.tsx` drives both actions through the real guard over a migrated SQLite fixture: anonymous, missing-CSRF, cross-form-CSRF and non-admin refusals each leave `deleted_at` untouched; the soft-delete/restore round trip lands on its own flash query; both idempotence cases hold; an unknown id returns the error instead of redirecting.
- [x] 2.3 Mutation-proof each guard with a file-copy backup under `/tmp` (never a git restore). Six mutations, each reddening the tests that name it: neutralize `guardAction` (4 authorization tests), verify the wrong form name in `deletePrompt` (cross-form test plus the happy paths), invert the `deleted` branch in `PromptActions` (3 UI tests), drop the `softDelete` call (3 state tests), make `undelete` call `softDelete` (2 state tests), change the delete flash copy (1 flash test). Restoring the backup left `page.tsx` byte-identical.
- [x] 2.4 `pnpm --filter @rembric/web run typecheck`, `pnpm exec eslint` on the three changed TS files, `pnpm exec prettier --check` and `git diff --check` are clean.

## 3. Document the restored contract

- [x] 3.1 Add `openspec/changes/restore-prompt-delete-undelete/` (`proposal.md`, `design.md`, this `tasks.md`) and restate the prompts-list requirement in `specs/dashboard/spec.md` without the retired `data-confirm` / `#rbr-confirm` mechanism. `openspec validate restore-prompt-delete-undelete --strict` reports the change is valid.
- [ ] 3.2 Operator-only: archive the change via `/opsx:archive` once the parent commits the work unit.

## 4. Known gaps (not carried as done)

- [ ] 4.1 Idempotence is a `PromptsService` property exercised end-to-end through the action. The page-side delegation is mutation-proven (dropping the `softDelete` call or pointing `undelete` at `softDelete` reds the state tests), but the service's own no-op-vs-reset semantics cannot be forced red from the page surface without mutating `packages/core/src/services/prompts.ts`, which is out of this change's edit surface. The backdated value in the idempotence test makes "unchanged" independent of millisecond resolution; it still proves the action as written leaves the column untouched rather than that the service is internally idempotent.
- [ ] 4.2 The `warn` tone is a declared `ConfirmSubmit` prop whose dialog content renders only once open, so it is not observable in the server-rendered HTML. The rendered tests prove the gate exists (dialog trigger on the Delete button, `type="button"`); the tone itself is verified by reading the call site.
