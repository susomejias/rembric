## Why

AI coding agents (Claude Code, Codex, Hermes, and others) lose context across sessions and across each other. Each invocation starts cold and rediscovers the same facts about the user, the project, and prior decisions. Existing solutions either tie the user to a vendor (built-in memory of a single agent), expose a complex framework (Redis agent-memory-server), or skip memory hygiene entirely (engram-style stores accumulate redundancy and drift).

We need a memory system that is:

- **Self-hosted and minimal**: a single npm package the user runs on a VPS. No SaaS dependency, no docker-compose to maintain, no proxy stack we ship.
- **Multi-client by design**: any MCP-capable agent (Claude Code, Codex, Hermes, future tools) can share the same memory through standard MCP-over-HTTP.
- **Scoped by project**: memories are either global to the user or scoped to a project, so cross-project pollution is prevented by construction.
- **Self-maintaining**: a background consolidation consolidates redundant memories, supersedes obsolete ones, and decays unused ones, using a configurable LLM endpoint (local Ollama by default). Every action is journaled and reversible.
- **Predictable**: an append-only schema with tombstones guarantees zero data loss, full auditability, and trivial undo of any consolidation decision.

## What Changes

This change introduces the entire v0 of **Rembric**, distributed as a single npm package named `rembric` (CLI/binary same name, singular) runnable with `npx rembric`. It exposes two HTTP surfaces from one process:

- **`/mcp`** — a Model Context Protocol server over Streamable HTTP, consumed by AI agents. Tools include `memory.save`, `memory.search`, `memory.get`, `memory.confirm`.
- **`/dashboard`** — a minimal HTMX + SSR web interface for browsing memories, inspecting consolidation runs, undoing operations, and managing tokens/projects.

Internally it runs a periodic consolidation loop that calls an OpenAI-compatible LLM endpoint (Ollama by default, but any compatible provider works) to merge, supersede, and archive memories under three pollution targets (redundancy, drift, contradiction). Decay (memories unused for long) is handled deterministically without LLM calls. Summarization of fragmented memories is deferred to v0.5.

The local store is SQLite with the `sqlite-vec` and FTS5 extensions, managed through Drizzle ORM with schema-as-code and generated migrations. The schema is strictly append-only with tombstones (status flips only, no DELETE, no content mutation) so that the audit trail is complete and every consolidation decision can be reversed.

Authentication uses bearer tokens for MCP clients and a cookie-based session for the dashboard, both seeded from a `REMBRIC_ADMIN_TOKEN` env var on first run. Configuration is 12-factor: env vars only, no parallel config files.

## Capabilities

### New Capabilities

- `memory`: lifecycle of memory records — save, search, get, confirm, archive — with append-only semantics, project/global scoping, FTS5 keyword retrieval, and immutable content.
- `consolidation`: background consolidation of memories. Detects candidates (redundant, drifted, contradictory, decayed) using sqlite-vec + FTS5, calls an LLM judge, applies atomic merge/supersede/archive operations, records a reversible journal.
- `projects`: scoping primitive. Resolves and persists projects, attaches memories to either `global` or a `project_id`, isolates consolidation per scope, manages project lifecycle (create, list, archive, rename).
- `mcp-api`: MCP-over-HTTP surface for AI agents. StreamableHTTP transport, bearer-token auth, project-scoped tools, server-side validation with zod, error handling.
- `dashboard`: minimal HTMX + SSR web UI at `/dashboard`. Browse memories with filters, inspect consolidation runs, undo operations, manage tokens and projects. No frontend build pipeline.
- `auth`: token-based authentication for both `/mcp` (bearer) and `/dashboard` (cookie session). Admin bootstrap via env var. Tokens revocable, scoped, and optionally expiring.
- `persistence`: SQLite-backed store managed by Drizzle ORM. Schema-as-code, generated migrations applied on startup, FTS5 virtual table and sqlite-vec virtual table maintained via triggers and raw SQL migrations.

### Modified Capabilities

None. This is the initial change.

## Impact

- **New repository scaffold**: `package.json`, `tsconfig.json`, Drizzle config, source tree, tests, CI workflow that runs typecheck + tests + `npm publish` on tag.
- **External dependencies**: `@modelcontextprotocol/sdk`, `drizzle-orm`, `drizzle-kit` (dev), `better-sqlite3`, `sqlite-vec`, `zod`, `htmx.org` and `@picocss/pico` as static assets bundled in `dist/public/`.
- **Required runtime**: Node 20+ (also runs on Bun). No Docker. No global system dependencies beyond Node and access to an OpenAI-compatible LLM endpoint (Ollama by default).
- **No prior systems are modified**: this is a greenfield product. Future changes may add summarization, multi-tenant team mode, libSQL-based local-first sync.
