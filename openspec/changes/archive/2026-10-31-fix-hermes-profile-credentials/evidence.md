# Validation evidence

## RED

Command against original provider:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests -p test_scoped_credentials.py -v
```

Verbatim output excerpts (full output retained in implementation tool transcript):

```text
FAIL: test_health_and_initialize_use_scoped_values_not_environment (test_scoped_credentials.ScopedCredentialsTest.test_health_and_initialize_use_scoped_values_not_environment)
First differing element 0:
('https://decoy.example/healthz', 'Bearer decoy-token', None)
('https://alpha.example/healthz', 'Bearer alpha-token', None)

FAIL: test_absent_secret_api_never_uses_environment (test_scoped_credentials.ScopedCredentialsTest.test_absent_secret_api_never_uses_environment)
AssertionError: True is not false

Ran 10 tests in 0.024s

FAILED (failures=11)
```

All tokens and hosts in these tests are synthetic.

## GREEN

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests -v
```

```text
Ran 111 tests in 0.851s

OK
```

Two `ResourceWarning` messages originated from existing HTTPError test fixtures; no failing tests.

```sh
openspec validate fix-hermes-profile-credentials --strict
```

```text
Change 'fix-hermes-profile-credentials' is valid
```

## Independent guard mutations

Each variant changed only `apps/plugin/.hermes-plugin/__init__.py` from the same clean implementation snapshot. Original bytes were restored in `finally`; all variants exited 1. The exact test command for every variant was:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests -p test_scoped_credentials.py -v
```

The table identifies the independent weakening, named detecting test (class `ScopedCredentialsTest`) and verbatim final result:

| Weakening                                                         | Detecting test                                                               | Result                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| Replace scoped `get_secret` import with `os.environ.get`          | `test_health_and_initialize_use_scoped_values_not_environment`               | `FAILED (failures=10)` |
| Return environment settings on scoped import error                | `test_absent_secret_api_never_uses_environment`                              | `FAILED (failures=2)`  |
| Return environment settings on scope exception                    | `test_scope_error_never_uses_environment_or_leaks_exception`                 | `FAILED (failures=1)`  |
| Remove missing URL condition independently                        | `test_missing_required_secrets_never_use_environment` (`REMBRIC_SERVER_URL`) | `FAILED (failures=1)`  |
| Remove missing token condition independently                      | `test_missing_required_secrets_never_use_environment` (`REMBRIC_API_TOKEN`)  | `FAILED (failures=1)`  |
| Add process-env default slug fallback                             | `test_missing_scoped_slug_does_not_use_environment_slug`                     | `FAILED (failures=1)`  |
| Disable thread-factory callable check                             | `test_absent_thread_api_disables_initialization`                             | `FAILED (failures=1)`  |
| Read process token inside HTTP helper                             | `test_http_helper_requires_explicit_token`                                   | `FAILED (failures=4)`  |
| Remove HTTP helper's missing-token condition                      | `test_http_helper_requires_explicit_token`                                   | `FAILED (failures=1)`  |
| Replace context factory with bare `threading.Thread`              | `test_two_instances_route_every_lifecycle_with_same_slug`                    | `FAILED (failures=3)`  |
| Use mutable `self._session_id` instead of captured worker session | `test_worker_captures_binding_before_scope_exit_and_session_switch`          | `FAILED (failures=1)`  |
| Re-raise thread creation/start exception                          | `test_thread_factory_or_start_error_is_safe`                                 | `FAILED (errors=1)`    |
| Print raw generic HTTP exception                                  | `test_http_errors_do_not_leak_credentials`                                   | `FAILED (failures=2)`  |
| Print raw HTTPError plus response body                            | `test_http_errors_do_not_leak_credentials`                                   | `FAILED (failures=1)`  |

Post-mutation full GREEN above verifies restoration. The test runner models the current supported single-profile API's native environment lookup separately from scoped gateway lookup; absence tests explicitly remove the host APIs.

## Independent HTTP integration

The parent ran a paired probe using official Hermes `secret_scope.py`, `memory_provider.py` and `hermes_constants.py` pinned to `c419cf7c864ac0ee511dbd9f7091a8bba0b567ee`. It used the real `load_env_file`, `set_secret_scope`, `get_secret` and `spawn_context_thread`, not a simulated resolver. The target was a fresh local Next.js instance at `http://localhost:3000` with separate project-scoped tokens for `me` and `homelab`. SQLite assertions checked each session's project, token and ended status.

Original provider, exit 1:

```text
me: correct project and token; background sync and session end persisted
AssertionError: homelab: wrong project attribution
```

Fixed provider, exit 0:

```text
me: correct project and token; background sync and session end persisted
homelab: correct project and token; background sync and session end persisted
PASS: 13 real HTTP requests; two isolated project/token owners; unscoped blocked; single-profile control passed; no token logs
```

The scratch probe was `/tmp/rembric-hermes-scope.N7M2y6/probe.py`; it released the worker after leaving the originating secret scope and verified persisted ownership. These are API/HTTP integration results, not full gateway dispatch evidence.

## Repository regression

- `pnpm exec turbo run test`: 3207 passed, 16 skipped across DB, core, MCP and web; all four tasks passed.
- `pnpm run e2e:installer`: 98 passed plus shell syntax checks.
- Canonical TUI installer in a disposable HOME: Hermes install twice produced identical files; uninstall twice preserved the synthetic credential/config files.
- `pnpm run typecheck && pnpm run lint`: baseline and final checks passed.
- Scoped Prettier check and `openspec validate fix-hermes-profile-credentials --strict`: passed after Markdown formatting.
- Active LSP probe: no confirmed-clean files; four inconclusive, with ten existing abstract-method ellipsis warnings in the provider. Python runtime tests supply the functional evidence.

## Independent verifier

A separate read-only verifier reported no actionable findings after running the 14 focused tests, all 111 Hermes tests, four additional adversarial controls, and the real-API HTTP probe with fresh session IDs. Its 13 HTTP requests independently confirmed project/token ownership, background/end persistence, unscoped rejection and native single-profile behavior. The additional controls covered same-slug token isolation with rejected-auth and passing controls, captured worker bindings, missing secrets/APIs and sanitized thread failures.

## Limits

No installed Hermes gateway/TUI is available here. Full native multiplexed gateway event dispatch remains an operator validation step. Native review is unavailable because the harness reports `managed_assets_outdated`; separate independent verification is required and no review approval is claimed. No production credentials, operator configuration, commits or version-carrier changes were used.
