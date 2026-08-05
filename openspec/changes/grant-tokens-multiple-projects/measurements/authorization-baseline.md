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

| token                  | `login` | `/mcp read`         | `/mcp write`        | `/mcp/alpha read`   | `/mcp/alpha write`  | `/mcp/home read`    | `/mcp/home write`   | `POST /api/alpha/sessions` | `POST /api/home/sessions` |
| ---------------------- | ------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | -------------------------- | ------------------------- |
| `*`                    | 302     | OK                  | OK                  | OK                  | OK                  | OK                  | OK                  | 200                        | 200                       |
| `read:*`               | 401     | OK                  | `forbidden`         | OK                  | `forbidden`         | OK                  | `forbidden`         | 403 `forbidden`            | 403 `forbidden`           |
| `project:<alpha>`      | 401     | `forbidden`         | `forbidden`         | OK                  | OK                  | `forbidden`         | `forbidden`         | 200                        | 403 `forbidden`           |
| `read:project:<alpha>` | 401     | `forbidden`         | `forbidden`         | OK                  | `forbidden`         | `forbidden`         | `forbidden`         | 403 `forbidden`            | 403 `forbidden`           |
| `invalid bearer`       | 401     | 401 `token_invalid` | 401 `token_invalid` | 401 `token_invalid` | 401 `token_invalid` | 401 `token_invalid` | 401 `token_invalid` | 401 `token_invalid`        | 401 `token_invalid`       |

## Where the measurement differs from what the proposal predicted

Nothing contradicts the expected table: all five rows reproduce cell for cell. One reading changed underneath an unchanged verdict, and it matters for §8's diff — a `project:<alpha>` token's path-less `/mcp` cells are still `forbidden`, but the **reason** moved. Before `retire-the-global-scope` the refusal was "no project is active on this connection"; now `/mcp` resolves to the default project and the refusal is "this token is not authorized for the default project". Same code, different cause, and the refusal message now names the default project. A diff on code alone cannot see that, which is why the message text is worth checking by hand in §8.
