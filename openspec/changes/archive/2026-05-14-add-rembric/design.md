## Context

AI coding agents (Claude Code, Codex CLI, Nous Hermes Agent, and others) increasingly support the Model Context Protocol (MCP) as a standard way to consume external tools and data. Memory across sessions and across agents remains an open problem: each agent has its own ad-hoc memory (or none), users juggle multiple memories that don't share state, and naive long-running stores accumulate redundancy, drift, and contradictions until retrieval quality decays.

This change introduces **Rembric** (npm package and CLI binary both named `rembric`, singular), a self-hosted MCP server that becomes the single memory source of truth for all the user's AI agents. It is deliberately small: one npm package, one process, one SQLite file. Sophisticated behavior (consolidation, scoping, undo) emerges from disciplined schema design rather than from infrastructure complexity.

### Architecture at a glance

```
                  ┌─────────────────────────────────────────────────┐
                  │              Agents (MCP clients)               │
                  │     Claude Code · Codex CLI · Hermes · …        │
                  └────────────────────────┬────────────────────────┘
                                           │  HTTPS via operator's
                                           │  reverse proxy
                                           │  Authorization: Bearer
                                           │  X-Rembric-Project (or path)
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                       rembric  (single Node process)                  │
   │                                                                       │
   │   ┌────────────────────────────┐   ┌───────────────────────────────┐  │
   │   │  /mcp        /mcp/<slug>   │   │  /dashboard                   │  │
   │   │  Streamable HTTP transport │   │  SSR HTML + HTMX              │  │
   │   │  ┌──────────────────────┐  │   │  ┌─────────────────────────┐  │  │
   │   │  │ memory.save          │  │   │  │ /login   /memories      │  │  │
   │   │  │ memory.search (FTS5) │  │   │  │ /consolidation /tokens  │  │  │
   │   │  │ memory.get  + history│  │   │  │ /projects               │  │  │
   │   │  │ memory.confirm       │  │   │  └─────────────────────────┘  │  │
   │   │  └──────────────────────┘  │   │                               │  │
   │   └─────────────┬──────────────┘   └─────────────┬─────────────────┘  │
   │                 │                                │                    │
   │                 ▼                                ▼                    │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  Service layer                                                │   │
   │   │   MemoryService · ProjectsService · TokensService · Sessions  │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   │                                   │
   │                                   ▼                                   │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  SQLite (Drizzle ORM, append-only + tombstones)               │   │
   │   │   memory · projects · confirmations · tokens · sessions       │   │
   │   │   consolidation_runs · consolidation_ops                      │   │
   │   │   + memory_fts  (FTS5)      + memory_vec  (sqlite-vec)        │   │
   │   └───────────────────────────────▲───────────────────────────────┘   │
   │                                   │                                   │
   │   ┌───────────────────────────────┴───────────────────────────────┐   │
   │   │  Background workers                                           │   │
   │   │   EmbeddingWorker          (every 30s + pre-consolidation)    │   │
   │   │   ConsolidationScheduler   (CONSOLIDATION_CRON, default 03:00)│   │
   │   │     └── candidate detection  →  LLM judge  →  atomic ops      │   │
   │   │         (redundancy / drift / contradiction / decay)          │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   │                                   │
   └───────────────────────────────────┼───────────────────────────────────┘
                                       │
                  OpenAI-compatible HTTP (/v1/chat/completions, /v1/embeddings)
                                       │
                                       ▼
                   ┌────────────────────────────────────────┐
                   │   LLM endpoint                         │
                   │   Ollama · OpenAI · LM Studio · …      │
                   └────────────────────────────────────────┘
```

### Memory lifecycle (append-only with tombstones)

```
   memory.save                consolidation merge       user / decay archive
     (new active)           (new active + supersede)
         │                          │                          │
         ▼                          ▼                          ▼
                          ┌──────────────────────┐
                          │  status = 'active'   │
                          └──────┬────────┬──────┘
                                 │        │
              consolidation:     │        │  memory.archive  /
              merge / supersede  │        │  decay rule
                                 ▼        ▼
                  ┌──────────────────┐ ┌──────────────────┐
                  │ status =         │ │ status =         │
                  │ 'superseded'     │ │ 'archived'       │
                  └────────┬─────────┘ └────────┬─────────┘
                           │                    │
                           └─── undo restores ──┘
                                back to 'active'
```

`content` is never UPDATEd. Rows are never DELETEd. Confidence is a
COUNT over the append-only `confirmations` event table. The
`consolidation_ops` journal records every transition with the LLM's
reasoning and can be reverted one op or one run at a time.

### Request scoping

```
   HTTP path                Header                    Resolved scope
   ─────────                ──────                    ──────────────
   /mcp/my-app              (any)                  →  project 'my-app'
                                                     (path wins)
   /mcp                     X-Rembric-Project=foo  →  project 'foo'
   /mcp                     (no header)            →  global only;
                                                     scope='project'
                                                     saves return a
                                                     'project_required'
                                                     structured error
```

## Goals / Non-Goals

**Goals:**

- A single npm package, runnable with `npx rembric`, that serves both an MCP-over-HTTP endpoint at `/mcp` and a web dashboard at `/dashboard`.
- Multi-client memory: any MCP-capable agent points at the same server and shares memory with the others.
- Project scoping by construction: memories are either `global` or `project`-scoped; consolidation never crosses scopes; agents pass scope via an HTTP header.
- Automatic memory hygiene: a background consolidation detects redundant, drifted, contradictory, and decayed memories and consolidates them via an LLM judge.
- Full auditability and reversibility: every consolidation action lands in a journal; any action can be undone.
- 12-factor configuration: env vars only, no parallel config file.
- Zero data loss by construction: schema is append-only with tombstones; content is immutable.
- Bring-your-own LLM: any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, Groq, OpenAI itself) works without code change.
- Maintainable into the long term: server-side rendered HTMX dashboard, no frontend build pipeline, schema-as-code with generated migrations.

**Non-Goals:**

- Multi-tenant team mode. v0 assumes a single user (possibly across multiple devices). Multi-user team mode is a future change.
- Local-first / offline mode. v0 is cloud-only by design; the user's agents talk to a hosted instance. A future change could reintroduce libSQL embedded replicas for local-first if there is demand.
- Docker image, docker-compose, or shipped reverse proxy. The npm package is the only deliverable; the operator brings their own supervisor (systemd, pm2, launchd) and reverse proxy (Caddy, Nginx, Traefik, Cloudflare Tunnel). Recipes in `examples/`.
- Summarization-based compaction of fragmented memories (pollution type 3). Deferred to v0.5 once the merge/supersede pipeline is proven.
- Pluggable LLM provider abstraction with multiple concrete adapters. v0 assumes OpenAI-compatible HTTP, which covers all real targets without an abstraction layer.
- A `propose` consolidation mode that asks the user to approve operations before applying. v0 ships `apply + journal + undo`; `propose` may be added later if trust calibration calls for it.

## Decisions

### Naming and identifier conventions

The project is **Rembric** (brand, used in prose, READMEs, the dashboard
banner). Every machine-readable identifier is the singular lowercase
`rembric`:

| Surface                                     | Identifier                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand / prose                               | Rembric                                                                                                                                                                      |
| npm package name                            | `rembric`                                                                                                                                                                    |
| CLI / bin entrypoint                        | `rembric` (e.g. `npx rembric`)                                                                                                                                               |
| Default data directory                      | `~/.rembric/` (file: `data.db`)                                                                                                                                              |
| Environment variables                       | `REMBRIC_HOST`, `REMBRIC_PORT`, `REMBRIC_DATA_DIR`, `REMBRIC_ADMIN_TOKEN`, `REMBRIC_SESSION_SECRET` (the `LLM_*` and `CONSOLIDATION_*` namespaces are intentionally generic) |
| MCP server identifier registered by the SDK | `rembric`                                                                                                                                                                    |
| HTTP request header carrying project scope  | `X-Rembric-Project`                                                                                                                                                          |
| Dashboard session cookie                    | `rembric_session`                                                                                                                                                            |
| systemd unit / pm2 app / launchd label      | `rembric.service` / `rembric` / `com.rembric`                                                                                                                                |
| GitHub repo / docs domain                   | follow brand (`rembric`)                                                                                                                                                     |
| Internal HMAC scope strings                 | `rembric:session`, `rembric:csrf`, etc.                                                                                                                                      |

The **domain vocabulary inside the codebase remains "memory"** (the noun
the product manages): `MemoryService`, `memory` table, `memory.save` tool,
`memory_fts`, `memory_vec`. Renaming the domain would obscure the model.
Only the _product_ surface changes; the _concept_ it manages does not.

Rationale: the brand "Rembric" is for humans (it is the name you read);
the identifier `rembric` is for machines (it is what you type). Keeping
them locked in case (`Rembric` brand, `rembric` everything else) means
nothing about casing is ambiguous, the npm package is short and easy to
type, and there is exactly one source of truth for what to grep for if
something needs to be renamed in the future.

### Cloud-only architecture (no local binary, no sync)

The system runs as a single hosted process. Agents connect over MCP-over-HTTP. There is no local replica, no sync protocol, no embedded libSQL, and no per-machine binary to update. Every release is `npm publish` + restart on the server; all clients see the new behavior immediately.

Rationale: local-first introduces sync complexity (conflict resolution, CRDT-grade discipline, multi-version coexistence) that dwarfs the value for this use case. Agents already require internet for LLM calls, so offline memory is a niche need. The operational simplification of "one place to update" is decisive.

Alternative considered: local-first with libSQL embedded replicas synced to a self-hosted libSQL server. Rejected because the operational cost of distributing and updating client-side binaries on every machine the user uses outweighs the offline benefit.

### Single npm package distribution (no Docker)

The product ships as one npm package, `rembric`, runnable via `npx rembric` on any host with Node 20+. No Docker image, no docker-compose. Operators wanting containers can write a 10-line Dockerfile themselves.

Rationale: a single distribution channel minimizes maintenance burden. Docker adds CI complexity (multi-arch builds, registry management) and an opinionated runtime (the user's existing container stack may conflict). The npm package is runtime-agnostic between Node and Bun and covers every operational target.

Alternative considered: dual distribution (npm + auto-built Docker image). Rejected for v0 to minimize maintenance surface; can be reintroduced if demand is concrete.

### Bring-your-own LLM via OpenAI-compatible HTTP

Provider selection uses generic vars (`LLM_PROVIDER`, `EMBEDDING_PROVIDER`, default `openai` for both) and per-provider settings live under a namespaced prefix (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`). The base URL must include the `/v1` path segment — matching the official OpenAI convention — so the same configuration works against OpenAI itself (`https://api.openai.com/v1`), a local Ollama (`http://localhost:11434/v1`), LM Studio, vLLM, Groq, Together, Anyscale, and any other provider that exposes the OpenAI chat-completions + embeddings shape. New providers (Anthropic, Cohere, …) slot in as additional `LLM_PROVIDER` values with their own `ANTHROPIC_*` / `COHERE_*` namespaces without touching the generic selectors.

Rationale: a pluggable-provider interface is overengineering when a single shared dialect already works. Adding the abstraction later, if a non-compatible provider matters, is a small refactor.

### SQLite with sqlite-vec and FTS5, managed by Drizzle ORM

Storage is one SQLite file (default `~/.rembric/data.db`) with the `sqlite-vec` and FTS5 extensions loaded. Schema is defined in TypeScript via Drizzle ORM (`drizzle-orm/better-sqlite3`), migrations are generated by `drizzle-kit generate` and applied on server startup. Vector and FTS virtual tables are created via raw-SQL migrations and kept in sync with the `memory` table via SQLite triggers.

Rationale: SQLite is rock-solid for single-writer workloads, and Drizzle gives schema-as-code, type-safe queries, and a generated migration trail without a heavyweight ORM. `better-sqlite3` works on both Node and Bun, keeping the distribution portable.

Alternative considered: libSQL (SQLite-compatible, supports remote sync). Deferred: the sync features add no value in cloud-only mode and migration to libSQL is a driver swap if it ever becomes relevant.

### Append-only schema with tombstones

The `memory` table never has rows deleted and never has `content` mutated. Lifecycle is expressed via a `status` column (`active | superseded | archived`) and a `replaces` JSON array linking to predecessor IDs. Counters that need concurrency-safe semantics (e.g. confidence) live in event tables (`confirmations`) and are computed as `COUNT(*)`.

Rationale: this discipline gives zero data loss, full audit history, trivial undo, and CRDT-friendly semantics should sync ever return. It costs almost nothing today (a few extra columns and a tombstone filter on queries) and pays compound interest forever.

### Three statuses, one link column

Status values are exactly `active`, `superseded`, `archived`. Merge and simple-supersede are the same operation (`replaces` is a JSON array of 1..N predecessor IDs); the operation type lives in the consolidation journal, not in `memory.status`. Undo of a merge re-activates the predecessors and archives the merged-into memory.

Rationale: minimizing state-machine surface area minimizes bugs and clarifies invariants. The consolidation journal carries the operational nuance.

### Background consolidation with `apply + journal + undo`

The consolidation runs on a cron schedule (default `0 3 * * *`), batches candidates per scope (global, then each project), calls the LLM judge to merge/supersede/archive, applies operations atomically, and writes a journal entry to `consolidation_runs` and `consolidation_ops`. Operations are reversible via the dashboard or CLI.

Rationale: `apply + journal + undo` builds trust through transparency rather than approval friction. A `propose` mode (where ops queue for user approval) is more complex and adds latency before benefits land; defer it unless real users ask.

### MCP over Streamable HTTP using the official SDK

The MCP surface uses `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`. Tools are validated with zod. Auth is bearer tokens via the `Authorization` header. Project scope is conveyed via the `X-Rembric-Project` header per call.

Rationale: the official SDK is the reference implementation with zero spec lag; the Streamable HTTP transport is the modern recommended HTTP transport (replacing the older SSE transport). Bearer tokens are the standard auth model and trivially generated by the admin CLI.

Alternative considered: FastMCP TS. Rejected because the boilerplate savings are marginal and the spec-lag risk and abandonment risk are nonzero.

### Dashboard at `/dashboard` with HTMX + SSR + Pico.css

The web dashboard is server-side rendered with template literals, interactive via HTMX, and styled by Pico.css (classless). No frontend framework, no build pipeline, no JavaScript bundle of our own. Static assets are bundled in `dist/public/`. Sessions use a signed httpOnly cookie established by submitting the admin token on `/dashboard/login`.

Rationale: a dashboard hosted in a browser is the natural surface for "consult my memory in the cloud", and HTMX + SSR is the most maintainable web stack possible: no framework upgrades, no transpiler churn, plain HTML that works forever.

Alternative considered: a TUI built with Ink. Rejected because the visual affordances of a browser (tables, scroll, bookmarks, links) suit the use case better, and Ink adds a React-shaped maintenance dependency.

Alternative considered: only a CLI. Rejected because consulting memory is inherently visual; the CLI is provided as a complementary surface for scripting, not as the primary admin UX.

### Developer experience and quality gates

The repo enforces consistency and correctness mechanically rather than by convention:

- **pnpm** is the package manager, pinned via the `packageManager` field in `package.json` (Corepack picks up the version automatically). The lockfile (`pnpm-lock.yaml`) is committed; `package-lock.json` and `yarn.lock` are not.
- **Prettier** for formatting, **ESLint** (`@typescript-eslint`, ordered imports, `no-floating-promises`, `consistent-type-imports`) for static rules; `eslint-config-prettier` disables formatting-related ESLint rules to avoid conflicts.
- **Husky** + **lint-staged** run Prettier and ESLint on staged files on every `git commit` via `pnpm exec`, followed by an incremental `tsc --noEmit` typecheck.
- **commitlint** with the conventional-commits ruleset gates commit messages via the `commit-msg` hook.
- **pre-push** runs the full test suite (`pnpm test`); failed tests block the push.
- All hooks are installed automatically by the `prepare` script on `pnpm install`; contributors do not need to remember to enable anything.

End-user distribution remains npm-registry-agnostic: anyone can install the published package with `npx rembric`, `pnpm dlx rembric`, `pnpm add -g rembric`, or `npm i -g rembric`. The pnpm choice is a development-time convention, not a runtime requirement.

Rationale: every quality bar the team cares about (formatting, typing, tests, commit hygiene) is enforced at the moment of commit/push, not at PR review or — worse — in production. This keeps trunk clean by construction.

### Testing as a first-class commitment

The product makes strong claims (zero data loss, full reversibility, scope isolation, append-only invariants). Those claims are worthless if not enforced by tests. v0 ships with:

- **Vitest** as the runner, works on both Node and Bun.
- **Coverage gates** (≥ 85% branches, ≥ 90% statements) enforced in CI; PRs that drop coverage fail.
- **Invariant tests** that codify the load-bearing schema rules: no `DELETE FROM memory`, no `UPDATE memory SET content=…`, only legal status transitions, consolidation never crosses scope, `replaces` graph is acyclic.
- **Property-based tests** (`fast-check`) for confirm-chain semantics and the `replaces` graph.
- **Migration round-trip tests** with a checked-in schema snapshot fixture: any unexpected schema diff fails CI.
- **Schema-drift test** comparing the Drizzle schema against the live DB after migrations.
- **Deterministic LLM mock** for consolidation correctness, idempotency, and reversibility tests, plus a real-endpoint smoke test gated on env.
- **MCP protocol conformance tests** using the official MCP TS SDK as the client.
- **Dashboard E2E tests** using Playwright headless.
- **Concurrency tests** for high-fanout `memory.save` to validate WAL behavior.

Rationale: every guarantee in the proposal corresponds to at least one named, enforced test. The schema discipline is not a convention; it is a CI gate.

### 12-factor env-var configuration only

All runtime configuration is via environment variables. No parallel JSON/YAML config file. Sensible defaults mean only `REMBRIC_ADMIN_TOKEN` is required for the first run.

Rationale: one source of truth, cloud-native pattern, easy to drive from systemd EnvironmentFile, pm2 ecosystem config, dotenv files, or `--env-file` on Docker/Bun.

## Risks / Trade-offs

- **Cloud-only means SPOF.** If the VPS goes down, the user has no memory. Mitigations: documented backup strategies (litestream to S3/R2, or simple rsync of `~/.rembric/data.db` to off-host storage), health-check recipe, automatic restart via systemd/pm2. The DB file itself is single-file SQLite, trivially backuppable.
- **No offline operation.** Agents need network connectivity to reach the server. Acceptable because agents already need network for their own LLM calls in most workflows.
- **Latency overhead per MCP call.** ~50-150ms per call vs. ~1ms for a local store. Invisible inside an agent turn that already takes seconds for an LLM call.
- **Consolidation LLM cost / quality dependency.** The consolidation's effectiveness depends on the LLM endpoint chosen. A weak model produces shallow merges; a slow endpoint slows the cron run. Mitigation: consolidation is configurable (`CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE`) and the operator selects the model.
- **Append-only growth.** The DB grows monotonically. Mitigation: `archived` memories are kept but a future `rembric db prune` command can vacuum old archived rows past a configurable age. Not in v0.
- **Hermes (Nous) MCP compatibility unverified.** The architecture assumes MCP-over-HTTP support in all target clients. Claude Code and Codex CLI are confirmed; Hermes requires verification. If Hermes only supports stdio, a thin local stdio↔HTTP proxy script (~30 lines) bridges the gap without affecting the server.
- **Bearer tokens stored in agent configs.** Tokens are long-lived secrets in plain-text config files on the user's machines. Mitigation: tokens are revocable from the dashboard, scoped per-project, and rotatable. Acceptable for self-hosted single-user workflows.
- **Single-writer assumption.** The server is the only writer to SQLite; concurrent writes from outside (e.g. running migrations while the server is up) will fail. Mitigation: documented operational rule that DB CLI commands require stopping the server first.
