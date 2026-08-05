# Pre-change authorization baseline

Captured by `authorization-baseline.mjs` at base `1cb9821995dfb17c0e0c94cc4d1ea9a74f8689e5`, on `main` with `retire-the-global-scope` merged (`c26ecfb`). Raw cells in `authorization-baseline.json`.

**Instruments, named and not interchangeable.** Minting is `POST /dashboard/tokens` (the real producer, so the persisted scope string is the one it writes); the admin gate is `POST /dashboard/login`; MCP is the SDK `StreamableHTTPClientTransport` against `/mcp` and `/mcp/<slug>`, never a direct handler call; the HTTP surface is `POST /api/<slug>/sessions`. Every cell carries the status **and** the structured code, because a change turning `forbidden` into `project_required` moves behaviour at an unchanged status.

**Non-vacuity (task 1.4): 16 of 45 cells are a success.** An after-run that diffs clean over an all-refused matrix would prove nothing, so this count is part of the baseline and must be unchanged and non-zero after the change.

**A control the script enforces before it will emit anything:** the `*` token must succeed on all three writes and both session posts. A malformed write probe is indistinguishable from a real denial — the first run of this script sent `type: 'note'`, which is not in `MEMORY_TYPES`, and the strict tool schema refused all six write cells with `-32602`. Without the control that would have been recorded as "writes are denied".

## Persisted scope strings (1.1)

| token name                    | `scope`                                   | `project` cell |
| ----------------------------- | ----------------------------------------- | -------------- |
| `baseline-star`               | `*`                                       | —              |
| `baseline-read-star`          | `read:*`                                  | —              |
| `baseline-project-alpha`      | `project:01KZ8QXJZ3KKHXJSE28JKK4MS3`      | alpha          |
| `baseline-read-project-alpha` | `read:project:01KZ8QXJZ3KKHXJSE28JKK4MS3` | alpha          |

## Matrix (1.2, 1.3)

| token                  | `login` | `/mcp read`                        | `/mcp write`                       | `/mcp/alpha read`                  | `/mcp/alpha write`                 | `/mcp/home read`                   | `/mcp/home write`                  | `POST /api/alpha/sessions` | `POST /api/home/sessions` |
| ---------------------- | ------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | -------------------------- | ------------------------- |
| `*`                    | 302     | OK                                 | OK                                 | OK                                 | OK                                 | OK                                 | OK                                 | 200                        | 200                       |
| `read:*`               | 401     | OK                                 | `forbidden`                        | OK                                 | `forbidden`                        | OK                                 | `forbidden`                        | 403 `forbidden`            | 403 `forbidden`           |
| `project:<alpha>`      | 401     | `forbidden`                        | `forbidden`                        | OK                                 | OK                                 | `forbidden`                        | `forbidden`                        | 200                        | 403 `forbidden`           |
| `read:project:<alpha>` | 401     | `forbidden`                        | `forbidden`                        | OK                                 | `forbidden`                        | `forbidden`                        | `forbidden`                        | 403 `forbidden`            | 403 `forbidden`           |
| `invalid bearer`       | 401     | transport refused, `token_invalid` | transport refused, `token_invalid` | transport refused, `token_invalid` | transport refused, `token_invalid` | transport refused, `token_invalid` | transport refused, `token_invalid` | 401 `token_invalid`        | 401 `token_invalid`       |

## A correction to this document

**The six invalid-bearer MCP cells originally printed `401 token_invalid`, and that status was never measured.** `authorization-baseline.json` records `{"transport":"refused","status":null}` for each: the SDK client throws before `initialize` completes, the throw carries the JSON error body but no status line, so the script's three-digit extraction returned null. The `401` was carried over from the expected table in task 1.2 — an expectation wearing a measurement's clothes, in the one document whose whole purpose is evidence. Corrected to what the instrument actually saw. Task 2.3 measures the status properly with a raw `initialize` POST (401, `token_invalid`) and keeps the SDK transport refusal as its own shape, per 1.3's rule that the two are materially different. **Task 8.1's re-run will reproduce `status: null` in these cells; that is not a regression.**

## Where the measurement differs from what the proposal predicted

Nothing contradicts the expected table: all five rows reproduce cell for cell. One reading changed underneath an unchanged verdict, and it matters for §8's diff — a `project:<alpha>` token's path-less `/mcp` cells are still `forbidden`, but the **reason** moved. Before `retire-the-global-scope` the refusal was "no project is active on this connection"; now `/mcp` resolves to the default project and the refusal is "this token is not authorized for the default project". Same code, different cause, and the refusal message now names the default project. A diff on code alone cannot see that, which is why the message text is worth checking by hand in §8.

## The after-run (task 8.1–8.3)

Re-run against the changed tree with the same script, the committed before-run copied out first and restored after so the JSON above is still the before-run. **45 cells compared, 0 moved**, ULIDs normalised. Non-vacuity unchanged: **16 successes of 45 on both sides**, so the identical diff is not an identical diff over an all-refused matrix. The only differing value anywhere is the `created_at` column of the persisted-scope table — two run times, not a behaviour. Reproduced independently by a review agent with its own instrument, same result.

## The new surface (task 8.4) — separate, and sourced

These three arms are **not** measured by `authorization-baseline.mjs`. It mints only the four pre-existing shapes, deliberately, so the regression instrument stays exactly what it was when the before-run was taken. The new surface is measured by `apps/server/src/test/token-project-sets.test.ts` at the same boundaries — the dashboard mint form, the MCP SDK `StreamableHTTPClientTransport`, and `POST /api/<slug>/sessions`.

| new arm                    | measured behaviour                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| set over `{alpha, gamma}`  | reaches both members read **and** write on `/mcp/<slug>` and on `POST /api/<slug>/sessions`; refused on `beta`, on the default project, and on the path-less `/mcp`. Asserted in **one** test so the grant and the refusal cannot be skipped separately.           |
| set over **every** project | denied `POST /dashboard/login` (401) and every `/admin/*` route (403 `forbidden`), while the `*` control succeeds on both (302, 200). This is the escalation control: reach must not become admin.                                                                 |
| memberless set             | authorizes nothing on any surface, and renders as `no projects` (class `pending`) — distinct from `active`, from `revoked`/`expired`, and from the unresolvable `inert`, whose never-repair contract does not apply to a set an operator can still add members to. |

Two properties of this surface that no assertion can establish on its own, both from §7's mutation gate: dropping the membership arm reds the member-reach test **while leaving the empty-set refusal test green** (a suite of refusal assertions cannot notice a grant that never happens), and memoizing the membership read reds exactly one test — the warm-cache freshness one.
