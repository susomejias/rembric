# PR 4 wire-diff classification

Source: `base-vs-candidate-pr4.txt` (wire-base at `origin/main` f9f769e5 against `feat/oauth-off-sdk-v1`, both on fresh `mktemp -d` data directories). 101 shapes: 36 `same`, 65 `DIFF`. Re-run after the SDK-simplification commits (`ec8f4290`, `0e7bc6fe`, `81425b16`, `466125e6`); the first run, before them, had 41 `same` and 60 `DIFF`.

## Non-OAuth shapes

57 of the 65 `DIFF` blocks are byte-identical to their blocks in `base-vs-candidate-pr3.txt` (compared block by block, field paths and values). They are classified in `pr3-diff-classification.md`; PR 4 removes none of them.

## OAuth shapes (071–101)

Three OAuth shapes differ, every one in the same two fields and nothing else:

| Shape | Request                                           | Base                             | Candidate                         |
| ----- | ------------------------------------------------- | -------------------------------- | --------------------------------- |
| 081   | `POST /token` (registered client, unknown code)   | `500`, `"error": "server_error"` | `400`, `"error": "invalid_grant"` |
| 093   | `POST /token` (`authorization_code`, reused code) | `500`, `"error": "server_error"` | `400`, `"error": "invalid_grant"` |
| 096   | `POST /token` (`refresh_token` reuse)             | `500`, `"error": "server_error"` | `400`, `"error": "invalid_grant"` |

`error_description`, every header and every other field are equal on both sides.

**Classification: the intended spec-conformance fix named in design.md "Open Questions", not a regression.** The live `mcp-oauth` spec requires it: "the server SHALL reject the exchange with `invalid_grant` and SHALL NOT issue a token" for a reused code (`openspec/specs/mcp-oauth/spec.md:84`) and "the server SHALL reject it with `invalid_grant` and SHALL revoke all access and refresh tokens in that grant family" for refresh reuse (`:144`); shape 081 (a code never issued) is the same `invalid_grant` domain error. And the in-process characterization suite (`apps/web/src/test/oauth-wire.test.ts`, "refuses a reused code", "replays the old refresh token after rotation") already pinned `400 invalid_grant`. Cause, consistent with every observation but inferred rather than traced in the bundle: base maps the domain error with `err instanceof OAuthError` against the `@rembric/core` class imported by `oauth-provider.ts`, and its `500` keeps the domain message as `error_description`, which is exactly the fallback that check takes on a miss (`ServerError(err.message)`); the same mismatch across Turbopack chunks is recorded for `DomainError` in 8375c5d0. The candidate recognises a domain error by its `name` and its `code` instead of by class identity (`toOAuthError` in `apps/web/src/lib/oauth-provider.ts`), pinned by `apps/web/src/test/oauth-router.test.ts` ("domain errors raised from another bundle copy of @rembric/core"); removing either half of that check reddens it.

The other 28 OAuth shapes (metadata, DCR, `/authorize`, preflight, `405`, token errors, the full grant, refresh rotation, `/revoke`) are `same`.

## In-process differential against the 1.x router

Before `@modelcontextprotocol/sdk` was removed, a scratch test drove the 1.x `mcpAuthRouter` (behind the old shims) and the rewrite with the same 299 requests: every method on every OAuth path and on `.well-known` sub-paths and case variants, `/authorize` query and form variants (duplicate, bracketed and percent-encoded keys, `]=` keys, malformed escapes, ISO-8859-1, gzip, unsupported charset and encoding, 1000/1001 parameters, a 100 KiB body), `/token` and `/revoke` refusals, code and refresh flows, `/register` variants (strict JSON, BOM, non-object bodies, rejected redirect URIs and auth methods, deflate) and IPv6 `/56` rate-limit grouping. 0 differed. Mutating the CORS method list, the bracket-key rule, the `]=` split, the `%5B`/`%5D` pre-pass, the ISO-8859-1 decoder, the duplicate merge and the parameter limit each made it report differences.

Four request shapes could not be compared because the 1.x router never answers them: a body over 100 KiB, a corrupt `gzip` body, and a `content-length` that does not match the body. body-parser's error path calls `on-finished` on the shimmed request, which throws `ee.on is not a function` as an uncaught exception and leaves the request pending. The rewrite answers each with the same `500 {"ok":false,"code":"internal_error"}` the shim returned for every other body-parser error (pinned in `oauth-router.test.ts`, "request body limit").

## Shapes changed by the SDK-simplification commits

Five shapes that were `same` in the first PR 4 run now differ. Each is an output change the commit messages and the proposal's "What is lost" row 11 name:

| Shape | Request                                       | Base                                                                   | Candidate                                                                                          | Commit                 |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 062   | `initialize` with a body over the 4 MiB cap   | `413 {"ok":false,"code":"payload_too_large",…}`                        | `413`, SDK JSON-RPC error `-32000 "Payload Too Large: Request body must not exceed 4194304 bytes"` | `81425b16`             |
| 063   | `initialize` with a disallowed `Origin`       | `"Invalid Origin header: https://evil.example"`                        | `"Invalid Origin: evil.example"`                                                                   | `81425b16`             |
| 065   | `initialize` with a disallowed `Host`         | `"Invalid Host header: rebind.example:80"`                             | `"Invalid Host: rebind.example"`                                                                   | `81425b16`             |
| 071   | `GET /.well-known/oauth-authorization-server` | `content-type` with `; charset=utf-8`; `client_secret_post` advertised | `application/json`; only `none` advertised for the token and revocation endpoints                  | `ec8f4290`, `0e7bc6fe` |
| 072   | `GET /.well-known/oauth-protected-resource`   | `content-type` with `; charset=utf-8`                                  | `application/json`                                                                                 | `ec8f4290`             |

**Classification: requested changes, not regressions.** 062 is the SDK's `maxRequestBodySize`, which reads the body as a stream and stops at the cap, where the route used to buffer it whole. 063 and 065 are the SDK's hostname-based `Host`/`Origin` validators. 071 stops advertising a client authentication method the server never registers or checks. The status of every one is unchanged.

The in-process differential above predates these commits. They deliberately drop ISO-8859-1 form bodies, bracketed keys and compressed bodies; an independent verification of the four commits found one blocker, a quadratic form-grouping loop that let a 100 KiB body of one repeated name stall `/token` for about 2 s, fixed in `466125e6` (linear append plus the previous 1000-parameter cap, pinned in `oauth-router.test.ts`, "refuses a form with more than 1000 parameters before building it").
