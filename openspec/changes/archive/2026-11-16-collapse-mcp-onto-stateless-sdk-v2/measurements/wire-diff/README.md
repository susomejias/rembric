# Differential wire harness

Replays a fixed catalogue of HTTP request shapes (`catalogue.mjs`) against two running Rembric servers and reports every difference in status, headers and body. PR 1 records base against base; PR 3 compares `origin/main` against the branch, and every difference it reports must map to a row of the proposal's "What is lost" table.

## Run

```sh
B=$(mktemp -d); C=$(mktemp -d)
./start-server.sh <base-worktree> 3101 "$B" > base.log 2>&1 &
./start-server.sh <candidate-worktree> 3102 "$C" > cand.log 2>&1 &
# wait for "Ready in" in both logs
node wire-diff.mjs --base http://localhost:3101 --candidate http://localhost:3102 \
  --token wire-diff-admin-token-0123456789abcdef --out result.txt [--dump records.json]
pkill -f 'next dev --port 310[12]'; pkill -f next-server; rm -rf "$B" "$C"
```

`start-server.sh` builds the workspace packages `apps/web` imports (skip with `WIRE_SKIP_BUILD=1`), then runs `next dev` from `<worktree>/apps/web` on `localhost:<port>` with:

- `REMBRIC_DATA_DIR` inside the given directory, which must be an empty `mktemp -d` directory outside the repository (it refuses a repo path, `data-dev/` or a non-empty directory);
- `REMBRIC_ADMIN_TOKEN` fixed (override with `WIRE_ADMIN_TOKEN`), `REMBRIC_PUBLIC_URL=http://localhost:<port>` so OAuth is on;
- `REMBRIC_MCP_ALLOWED_HOSTS=localhost:<port>` and `REMBRIC_MCP_ALLOWED_ORIGINS=http://localhost:<port>` so the DNS-rebinding shapes are exercised (both overridable from the environment);
- `REMBRIC_MODEL_CACHE` pointed at an empty directory, so the embedder never downloads and every search takes the deterministic FTS5 fallback;
- `REMBRIC_UPDATE_CHECK=off`; rate limiting at its defaults (MCP limiter off, OAuth endpoint limiters on). Any other variable, such as `MAX_BODY_BYTES`, is inherited.

Every comparison needs two freshly started servers on fresh data directories: the catalogue writes memories, sessions, OAuth clients and consumes OAuth rate-limit quota, so a second run against the same servers compares different state.

`--stream-ms` (default 16000) is how long the standalone `GET` stream is read; it must exceed the 15 s keepalive interval. `--timeout-ms` (default 60000) bounds every other response. A run takes about 33 s on cold `next dev` servers, 16 s of which is the keepalive window. Exit codes: `0` identical, `1` at least one difference, `2` harness error (connection refused, timeout, bad arguments).

## Catalogue

Steps run in order, and each server keeps its own captured values, so a later step reuses the session id, Rembric session id, memory ids, OAuth client id, code and tokens that the same server returned. A step whose captured value is missing sends the request without it, which is how PR 3's stateless server (no `Mcp-Session-Id`) still gets every shape replayed.

Covered: `initialize` (2025-06-18 and 2025-03-26, path-less, `/mcp/<default slug>`, `/mcp/<unknown slug>`, an invalid slug), `notifications/initialized`, `ping`, an unknown method, `tools/list`, a `tools/call` of each of the 25 tools `tools/list` returns on the base plus the two-step `memory.merge` (preview, then commit with the returned fingerprint), validation, unknown-tool and `project_not_found`/`scope_locked` refusals, the standalone `GET` stream and its keepalive, `GET`/`DELETE` with and without a session id, a deleted and an unknown `mcp-session-id`, no bearer, an invalid bearer, a non-Bearer scheme, `Accept` without `text/event-stream`, a non-JSON `Content-Type`, malformed JSON, a JSON-RPC batch, a body over the 4 MiB cap, a disallowed `Origin` and `Host` with an allowed-`Origin` control, the 2026-07-28 shapes of `mcp-http.test.ts` (`server/discover`, an enveloped `tools/list`, `notifications/cancelled`, a header without envelope, an envelope claiming 2025-06-18), both OAuth metadata documents, DCR valid and invalid, `/authorize` (unregistered client, `plain` PKCE), CORS preflight, `GET /token`, `/token` errors (unregistered client, unknown code, unsupported grant), and a full browser-shaped grant: dashboard login, consent page and consent POST (approve and deny), wrong PKCE verifier, valid exchange, reused code, an MCP `initialize` with the OAuth access token, refresh rotation, refresh reuse detection and its effect on the rotated token, and `/revoke`.

Not covered, by construction: the failure paths `mcp-errors.test.ts` reaches by stubbing services (a live server cannot be made to throw on demand), the MCP rate limiter's `429` (it is off by default and the task keeps defaults), and request shapes driven through the SDK client in `mcp-transport.test.ts` beyond one call per tool (their wire form is the same `tools/call` envelope).

## What counts as a difference

Each response becomes a record of `status`, every response header except `date`, `content-length`, `transfer-encoding`, `keep-alive` and `etag`, and the body. JSON bodies are parsed, SSE bodies are split into events (comments such as `: keepalive` are kept), and a tool result's JSON `text` is parsed in place. The consent page's HTML is compared by status and headers only.

Volatile values are masked per server before comparing: the server's own origin and host, ISO and HTTP dates, `HH:MM UTC` clocks, durations in `ms`, numbers under keys ending in `At`/`_at`/`Ms`/`_ms`/`duration`/`elapsed`/…, and the `ratelimit-reset`/`retry-after` header values become fixed placeholders. ULIDs, UUIDs (session ids), 26-character project ids, SHA-256 hex digests (merge fingerprints) and `oauthc_` client ids become ordinals (`<ulid:3>`, `<uuid:1>`) numbered by first appearance on that server, so reuse of an id stays visible; opaque tokens, codes and `areq` blobs become `<opaque>`. Only values are masked: a header, field or event present on one side and absent on the other is always reported, as `(absent)`.

## Reading the output

One line per shape, `same` or `DIFF`, with its catalogue number. For each `DIFF` a block follows with one pair of lines per differing field path, `-` for base and `+` for candidate. Ordinals are positional, so a shape that mints one id fewer shifts the ordinals of later ids: read such a later block as a consequence of the earlier one, not as a new difference.

## Recorded runs

- `base-vs-candidate-pr1.txt`: `wire-base` (detached at `origin/main`) against this branch at PR 1, whose server code is identical. 101 shapes, 0 differences, exit 0, 33.2 s.
- `sensitivity-control.txt`: the same pair with the candidate started with `MAX_BODY_BYTES=2048 REMBRIC_MCP_ALLOWED_ORIGINS=https://other.example`. Exit 1, naming shape 062 (the `413` message names the 2048-byte limit), shape 064 (the allowed-`Origin` control answers `403`; `mcp-session-id`, `cache-control` and `x-accel-buffering` are reported absent) and shape 094, whose only change is the session-id ordinal shifted by 064 minting no session.
- `base-vs-candidate-pr3.txt`: `wire-base` (detached at `origin/main`) against PR 3, the stateless handler and removals. 101 shapes, 57 differences, exit 1; each is classified against the proposal's "What is lost" table in `pr3-diff-classification.md`.
- `base-vs-candidate-pr4.txt`: `wire-base` (detached at `origin/main`) against PR 4, the OAuth authorization server on Web `Request`/`Response`. 101 shapes, 60 differences, exit 1: the 57 of PR 3, unchanged, plus `/token` shapes 081, 093 and 096 answering `400 invalid_grant` where base answers `500 server_error`; classified in `pr4-diff-classification.md`.
