## 1. Repository scaffold and developer tooling

- [ ] 1.1 Create `package.json` declaring `memoria-server` with bin entrypoint, `engines.node >= 20`, ESM type module, and CLI subcommands wired
- [ ] 1.2 Set up `tsconfig.json` with strict mode, ES2022 target, NodeNext module resolution, and `outDir: dist`
- [ ] 1.3 Configure ESLint with `@typescript-eslint`, `eslint-plugin-import` (ordered imports), and rules: `no-floating-promises`, `no-unused-vars`, `consistent-type-imports`
- [ ] 1.4 Configure Prettier with a project `.prettierrc` (single-quote, semi, trailing-comma, printWidth 100) and a `.prettierignore`
- [ ] 1.5 Wire `eslint-config-prettier` so ESLint and Prettier do not fight; add `lint`, `lint:fix`, `format`, `format:check` npm scripts
- [ ] 1.6 Install and configure Husky; add `prepare` script that runs `husky` to set up hooks on `npm install`
- [ ] 1.7 Configure `lint-staged` to run `prettier --write` and `eslint --fix` on staged `.ts` / `.tsx` / `.md` files
- [ ] 1.8 Configure commitlint with `@commitlint/config-conventional`; document accepted commit types in `CONTRIBUTING.md`
- [ ] 1.9 Husky `pre-commit` hook → runs `lint-staged` and then `tsc --noEmit --incremental` (fail fast on type errors)
- [ ] 1.10 Husky `commit-msg` hook → runs `commitlint --edit "$1"` to enforce conventional commits
- [ ] 1.11 Husky `pre-push` hook → runs `npm run test` (full suite); fails the push on any test failure
- [ ] 1.12 Add `drizzle.config.ts` pointing at `src/db/schema` and `src/db/migrations`
- [ ] 1.13 Create initial source tree: `src/{server,mcp,dashboard,db,services,ceremony,cli,llm}/`
- [ ] 1.14 Add `examples/` with systemd unit, pm2 ecosystem, launchd plist, and Caddy/Nginx/Traefik snippets
- [ ] 1.15 Write `README.md` with quickstart, env-var reference, and process-supervisor/proxy recipes
- [ ] 1.16 Write `CONTRIBUTING.md` documenting the commit-message convention, the pre-commit/pre-push gates, and the test/coverage expectations
- [ ] 1.17 Add `LICENSE`, `.editorconfig`, and `.npmignore`

## 2. Database layer

- [ ] 2.1 Define Drizzle schema for `memory` table (id, scope, project_id, type, content, tags JSON, status, replaces JSON, created_at, last_seen_at, source JSON)
- [ ] 2.2 Define Drizzle schema for `projects` table (id, path, created_at)
- [ ] 2.3 Define Drizzle schema for `confirmations` event table (id, memory_id, event_ts, source JSON)
- [ ] 2.4 Define Drizzle schema for `ceremony_runs` table (id, started_at, finished_at, llm_provider, llm_model, scope, summary)
- [ ] 2.5 Define Drizzle schema for `ceremony_ops` table (id, ceremony_id, op_type, affected_ids JSON, created_id, reasoning, applied)
- [ ] 2.6 Define Drizzle schema for `tokens` table (id, name, hash, scope, project_id, created_at, revoked_at, expires_at)
- [ ] 2.7 Define Drizzle schema for `dashboard_sessions` table (id, token_id, created_at, expires_at)
- [ ] 2.8 Generate baseline migration via `drizzle-kit generate`
- [ ] 2.9 Write raw-SQL migration enabling WAL mode, creating `memory_fts` virtual table with FTS5, and triggers to keep it in sync
- [ ] 2.10 Write raw-SQL migration creating `memory_vec` virtual table via sqlite-vec with embedding column matching the configured embed dimension
- [ ] 2.11 Implement migrations runner that applies pending migrations on startup, with a `--lock` flag to prevent concurrent runs
- [ ] 2.12 Implement DB initialization helper that creates the data directory if missing, opens the SQLite file, loads sqlite-vec extension, applies migrations
- [ ] 2.13 Export typed `db` client and reusable query helpers (`findActiveMemory`, `findCandidates`, etc.)

## 3. LLM provider integration

- [ ] 3.1 Implement OpenAI-compatible HTTP client (chat completions + embeddings) using fetch, with retries, timeouts, and structured errors
- [ ] 3.2 Implement `generate(prompt, schema)` helper that validates LLM JSON output via zod
- [ ] 3.3 Implement `embed(text)` helper that calls the embeddings endpoint and returns `Float32Array`
- [ ] 3.4 Add env-var loading and validation for `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBED_MODEL`, `EMBEDDING_ENABLED`
- [ ] 3.5 Add a CLI command `memoria-server llm ping` that verifies the endpoint is reachable and responds

## 4. Memory service (core domain logic)

- [ ] 4.1 Implement `memory.save({ scope, project, type, content, tags, source })` that inserts a new active memory and (if embeddings enabled) queues embedding computation
- [ ] 4.2 Implement `memory.get(id)` that returns the memory and walks the `replaces` chain to expose history
- [ ] 4.3 Implement `memory.search({ scope, project, query, type, tags, status, limit, offset })` using FTS5 + filters
- [ ] 4.4 Implement `memory.confirm(id)` that follows the chain to the current head (status=active) and inserts a `confirmations` event
- [ ] 4.5 Implement `memory.archive(id)` that sets status=archived (user-driven decay)
- [ ] 4.6 Implement embedding worker: dequeue memories without embeddings, call `embed(content)`, insert into `memory_vec`
- [ ] 4.7 Add unit tests for save/get/search/confirm/archive and the embedding worker

## 5. Project scoping

- [ ] 5.1 Implement `projects.findOrCreate(path)` that resolves project from path, persists if new
- [ ] 5.2 Implement `projects.list()`, `projects.rename()`, `projects.archive()`
- [ ] 5.3 Enforce scope semantics: `memory.save` with `scope='project'` requires a valid `project_id`; `scope='global'` rejects a `project_id`
- [ ] 5.4 Add unit tests for project resolution and scope enforcement

## 6. Ceremony engine

- [ ] 6.1 Implement candidate detection for redundancy: per scope, find pairs of active memories with high vec similarity (sqlite-vec kNN) above a configurable threshold
- [ ] 6.2 Implement candidate detection for drift: find pairs of memories of the same type/tag where the newer one contradicts the older (LLM judges)
- [ ] 6.3 Implement candidate detection for contradiction: find sets of mutually contradictory active memories on the same subject (LLM judges)
- [ ] 6.4 Implement decay: mark memories archived if `last_seen_at` is older than a configurable threshold and confidence is below a configurable floor
- [ ] 6.5 Implement LLM judge that proposes merge/supersede operations given candidate sets, returning a structured zod-validated decision
- [ ] 6.6 Implement atomic op application: within a transaction, insert merged memory (if any), update affected rows' status and add the new id to `replaces`, write `ceremony_ops` entries
- [ ] 6.7 Implement ceremony runner that orchestrates per-scope batches with configurable `CEREMONY_BATCH_SIZE`
- [ ] 6.8 Implement cron scheduler honoring `CEREMONY_CRON` and `CEREMONY_ENABLED`
- [ ] 6.9 Implement `ceremony.undo(opId)` and `ceremony.undoRun(runId)` that reverse status flips and archive the merged-into memory
- [ ] 6.10 Add unit tests for each pollution-type detector and integration tests for full ceremony runs against a seeded DB

## 7. Auth and tokens

- [ ] 7.1 Implement token generation, hashing (argon2 or bcrypt), and storage; tokens shown once in plaintext at creation, hashed at rest
- [ ] 7.2 Implement bearer-token middleware for `/mcp` that validates against `tokens`, enforces scope, and rejects revoked/expired
- [ ] 7.3 Implement admin-token bootstrap from `MEMORIA_ADMIN_TOKEN`: on first run, seed a token row with name `admin` and scope `*`
- [ ] 7.4 Implement cookie-based session for `/dashboard`: login posts admin token, server sets signed httpOnly cookie, stored in `dashboard_sessions`
- [ ] 7.5 Implement CLI subcommands: `memoria-server token create <name> [--project <name>] [--expires <iso>]`, `token list`, `token revoke <name>`
- [ ] 7.6 Add unit tests for token validation, scope enforcement, and session lifecycle

## 8. MCP HTTP surface

- [ ] 8.1 Wire up `McpServer` from `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport` mounted at `/mcp`
- [ ] 8.2 Implement bearer-token auth check before the MCP handshake
- [ ] 8.3 Extract project scope from `X-Memoria-Project` header and inject into call context
- [ ] 8.4 Register `memory.save` tool with zod input schema (scope, type, content, tags) and structured response
- [ ] 8.5 Register `memory.search` tool with zod input schema (query, type, tags, status, limit) and structured response
- [ ] 8.6 Register `memory.get` tool with input id and response including history chain
- [ ] 8.7 Register `memory.confirm` tool with input id and a no-op response on success
- [ ] 8.8 Add request-level rate limiting per token (configurable; default off)
- [ ] 8.9 Add structured error responses matching MCP conventions (with helpful message strings)
- [ ] 8.10 Add integration tests using the official MCP TS SDK as a client against an in-process server instance

## 9. Dashboard web UI

- [ ] 9.1 Implement minimal SSR engine: an `html` tagged template literal with safe interpolation (HTML-escape by default, opt-in raw via marker)
- [ ] 9.2 Bundle HTMX 2.x and Pico.css as static files served from `/dashboard/assets/`
- [ ] 9.3 Implement layout component (header with project switcher, nav, footer)
- [ ] 9.4 Implement `/dashboard/login` route: form posts admin token, sets cookie, redirects to `/dashboard`
- [ ] 9.5 Implement `/dashboard` home: stats (memories per project, last ceremony summary, token count), recent activity
- [ ] 9.6 Implement `/dashboard/memories` list view: filters (project, type, status, search), pagination, HTMX-powered filter form
- [ ] 9.7 Implement `/dashboard/memories/:id` detail: full content, history chain visualization, confirmations count, source, archive button
- [ ] 9.8 Implement `/dashboard/ceremony` list of runs: timestamp, llm/model, ops count, summary
- [ ] 9.9 Implement `/dashboard/ceremony/:id` detail: per-op view with LLM reasoning, "undo this op" and "undo whole run" buttons
- [ ] 9.10 Implement `/dashboard/projects`: list, rename, archive
- [ ] 9.11 Implement `/dashboard/tokens`: list, create (shows plaintext once), revoke
- [ ] 9.12 Add CSRF protection on mutating HTMX requests
- [ ] 9.13 Add E2E tests using a headless browser harness

## 10. CLI surface

- [ ] 10.1 Wire CLI entrypoint via the `bin` field in package.json
- [ ] 10.2 Implement `memoria-server` (no subcommand) → starts the server
- [ ] 10.3 Implement `memoria-server status` → prints health, count by scope, last ceremony
- [ ] 10.4 Implement `memoria-server ceremony run-now` → triggers a ceremony on demand against a running server (via local HTTP)
- [ ] 10.5 Implement `memoria-server db migrate` → applies pending migrations (requires server stopped; fails fast otherwise)
- [ ] 10.6 Implement `memoria-server llm ping` (already in section 3)
- [ ] 10.7 Implement `memoria-server token …` (already in section 7)
- [ ] 10.8 Implement helpful `--help` output for every subcommand

## 11. Configuration and bootstrap

- [ ] 11.1 Centralize env-var parsing into `src/config.ts` with zod validation and explicit defaults
- [ ] 11.2 Print a startup banner with effective config (with secrets redacted) for operator clarity
- [ ] 11.3 Fail fast with a clear error message if `MEMORIA_ADMIN_TOKEN` is missing on first run
- [ ] 11.4 Print a one-time hint on first successful run pointing to `/dashboard/login` with the configured token

## 12. Packaging and release

- [ ] 12.1 Set up TS build pipeline producing `dist/` with type declarations and the bundled `public/` assets
- [ ] 12.2 Configure `npm pack` to include only `dist/`, `package.json`, `README.md`, `LICENSE`, `examples/`
- [ ] 12.3 Set up CI workflow: typecheck, lint, unit tests, integration tests, on tag push run `npm publish`
- [ ] 12.4 Add a smoke test in CI: install the published package in a fresh sandbox and run `npx memoria-server llm ping` against a stubbed endpoint
- [ ] 12.5 Document upgrade path: stop service, `npm i -g memoria-server@latest`, restart; migrations are idempotent

## 13. Testing infrastructure and invariants

- [ ] 13.1 Set up Vitest as the test runner (works natively on Node and Bun); add `test`, `test:watch`, `test:coverage` scripts
- [ ] 13.2 Add `@vitest/coverage-v8` and configure coverage thresholds (lines/branches/functions ≥ 85%, statements ≥ 90%) that fail CI when not met
- [ ] 13.3 Build a test-DB fixture: per-test in-memory SQLite with sqlite-vec loaded, FTS5 enabled, migrations applied; teardown is implicit
- [ ] 13.4 Build a deterministic LLM mock provider: returns canned zod-valid responses keyed by input hash, with assertable call log
- [ ] 13.5 Build a clock fixture: freezable/forwardable time used by ceremony schedule and `last_seen_at` decay tests
- [ ] 13.6 Build a token/auth fixture: helpers to mint test tokens with arbitrary scopes and inject them into HTTP requests
- [ ] 13.7 Write invariant tests asserting the append-only contract: no code path emits a `DELETE FROM memory`, no code path emits an `UPDATE memory SET content=…`; enforce via runtime assertions in dev and a grep test in CI
- [ ] 13.8 Write invariant tests for the status state machine: only legal transitions (active→superseded, active→archived, archived→active, superseded→active via undo) are reachable
- [ ] 13.9 Write invariant tests for scope discipline: ceremony never produces an op whose affected_ids span more than one (scope, project_id) tuple
- [ ] 13.10 Write property-based tests (using `fast-check`) for the `replaces` graph: cycles are impossible; the head of any chain is reachable in O(depth)
- [ ] 13.11 Write property-based tests for confirm-chain: confirming any predecessor always increments the count of the current head's confirmations
- [ ] 13.12 Add migration round-trip tests: every generated migration runs forward on an empty DB, then a snapshot of the resulting schema is asserted against a checked-in fixture (any unexpected diff fails CI)
- [ ] 13.13 Add a "schema-drift" test: parses Drizzle schema, parses the current DB after applying migrations, asserts they match
- [ ] 13.14 Add MCP protocol conformance tests using the official MCP TS SDK as the client against an in-process server (covers handshake, tool listing, tool invocation, error shapes)
- [ ] 13.15 Add ceremony correctness tests: seed a DB with known redundant/drifted/contradictory/decayed memories, run ceremony with the deterministic LLM mock, assert the resulting journal and final state
- [ ] 13.16 Add ceremony idempotency tests: running ceremony twice on the same state produces no new ops
- [ ] 13.17 Add ceremony reversibility tests: every ceremony run can be undone to bit-for-bit equality with the pre-run state (excluding the journal itself)
- [ ] 13.18 Add concurrency tests: 100 concurrent `memory.save` calls leave the DB in a consistent state with the correct count
- [ ] 13.19 Add embedding worker tests: backfill behavior, retry on transient LLM failure, skip on `EMBEDDING_ENABLED=false`
- [ ] 13.20 Add config tests: env-var validation rejects malformed values with helpful messages; defaults are documented and tested
- [ ] 13.21 Add token/auth tests: revoked tokens are rejected immediately, expired tokens are rejected, scope mismatches return 403, admin token bootstrap is idempotent
- [ ] 13.22 Add dashboard E2E tests using Playwright in headless mode: login flow, browse memories, undo a ceremony op, create/revoke a token, CSRF rejection
- [ ] 13.23 Add CLI tests: every subcommand exits with the expected code, stdout is parseable where documented, `--help` is non-empty
- [ ] 13.24 Add a smoke test that runs `npx memoria-server` against an LLM mock for 60 seconds and asserts no unhandled errors, no DB locks, healthy `status` output
- [ ] 13.25 Wire all of the above into a single `pnpm test:ci` (or `npm test`) target that CI runs on every PR and tag

## 14. Documentation

- [ ] 14.1 Quickstart in README: `npx memoria-server` with minimal env
- [ ] 14.2 Env-var reference table in README
- [ ] 14.3 Agent integration guides: Claude Code (validated), Codex CLI (validated), Hermes (pending verification, document stdio↔HTTP bridge fallback)
- [ ] 14.4 Process-supervisor recipes in `examples/`: systemd, pm2, launchd
- [ ] 14.5 Reverse-proxy recipes in `examples/`: Caddy, Nginx, Traefik, Cloudflare Tunnel
- [ ] 14.6 Backup strategy doc: rsync, litestream, periodic snapshot
- [ ] 14.7 Troubleshooting guide: common errors, LLM endpoint issues, migration failures, locked DB
