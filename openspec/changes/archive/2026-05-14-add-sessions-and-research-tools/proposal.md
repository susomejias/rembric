## Why

The current MCP surface (`memory.save`, `memory.search`, `memory.get`, `memory.confirm`) covers persistence but not the actual workflow of an agent doing research across time. Six concrete movements are unsupported today:

1. **Bootstrap a session with context** — when an agent connects, it has no way to ask "what should I know about this project?" without already knowing what to search for. `memory.search` requires a keyword.
2. **Drill down temporally** — given an interesting memory, an agent cannot ask "what was discussed near this one?". `memory.get` walks `replaces` chains but ignores time.
3. **Hand off between sessions** — the next session starts blind. There is no place to write "we were in the middle of X, the next step is Y".
4. **Capture findings without ceremony** — every save creates a new row. There is no "extract the `## Key Learnings` from this transcript" path.
5. **Self-diagnose** — an agent cannot ask "is the memory store healthy? what are the counters?".
6. **Read protocol from the tools themselves** — the existing tool descriptions document what each call does, but do not teach the agent **when** to call it. Engram's descriptions ("Call `mem_save` IMMEDIATELY after a bug fix") move the agent's hit-rate by orders of magnitude.
7. **Receive a system-prompt-level protocol at connection time** — the MCP lifecycle spec defines an optional `instructions` field on the `initialize` response that supported clients (Claude Code, Codex CLI, …) inject directly into the LLM's system prompt. Engram requires the operator to paste a "Memory Protocol" into each agent's prompt manually. Rembric can ship the same protocol over the wire so it works on first connection without out-of-band setup.
8. **Discover which project they are in without per-folder configuration** — today, an agent registered once at `/mcp` (global scope) has no way to know which folder the user is currently working in. The operator must register one MCP entry per project (`/mcp/<slug>` per folder) or every save lands in global. The MCP lifecycle defines a `roots` capability that supported clients (Claude Code, Codex CLI) advertise at handshake; the server can call `roots/list` to learn the agent's working directories without the agent passing them explicitly. Combined with slug-as-identity, that turns "what project am I in?" into a server-resolved question instead of a configuration burden.

This change adds the missing surface so that an agent connecting to Rembric for the first time has the same research ergonomics as Engram, without changing the semantics of the existing four tools.

## What Changes

This change is **purely additive**. It does not modify the contract of `memory.save`, `memory.search`, `memory.get`, or `memory.confirm` (their request/response shapes stay identical). It introduces:

- **A `sessions` table** in the persistence layer. Each session ties a token + agent + project to a span of time and a structured summary. Existing `memory` and `confirmations` rows gain an optional `session_id` foreign key so observations are anchored to their origin session.
- **Three session lifecycle tools** on the MCP surface: `memory.session_start`, `memory.session_end`, `memory.session_summary`.
- **Three research tools**: `memory.context` (recent sessions + observations bootstrap), `memory.timeline` (chronological drill-down within a session), `memory.capture_passive` (extract `## Key Learnings:` blocks from arbitrary text).
- **Two observability tools**: `memory.doctor` (operational JSON report), `memory.stats` (counters by scope/status/type).
- **Re-written descriptions** for the four existing tools so they teach the protocol, not just the API.
- **A server-emitted `instructions` block on the MCP `initialize` response** that ships the full Memory Protocol (when to save, when to search, session-close behavior, scope rules) at handshake time, scope-aware (path-scoped vs unscoped connections emit different copy).
- **Project identity migrated to slug-only**. The `projects.path` column is renamed to `projects.slug`. Paths never appear in the tool API and never cross the MCP wire. A slug is the cross-machine, cross-checkout stable identifier of a project.
- **Three project-management tools** under a new top-level `project.*` namespace: `project.use`, `project.list`, `project.current`. The defaults are conservative (`autocreate: false`, `confirmSwitch: false`) so an agent never silently creates a project nor switches mid-session without explicit user confirmation.
- **Server-driven project auto-detection via MCP `roots`**. When a client advertises `capabilities.roots` at handshake, the server queries `roots/list`, derives a candidate slug from the first root, and activates a _pre-existing_ project with that slug if there is no active project in the session. Discovery never creates projects and never overrides a project that the URL path already pinned.
- **Removal of the `X-Rembric-Project` header.** The header is dropped from the scope-resolution path. Project scope is resolved exclusively from `/mcp/<slug>` (URL path), `roots`-based auto-detection (when supported), or an explicit `project.use({slug})` tool call. One header less to misconfigure.
- **A dashboard view** at `/dashboard/sessions` listing recent sessions and linking through to their observations and summaries.

The follow-up change (`convergent-saves-and-synchronous-judgment`) will introduce `topic_key`, save-time conflict surfacing, and `memory.judge` — those are deliberately out of scope here because they change the semantics of `memory.save` and need a separate review.

## Out of scope

- Any change to `memory.save`, `memory.search`, `memory.get`, or `memory.confirm` request/response shapes. Only their tool descriptions are rewritten.
- `topic_key` and convergent upsert (deferred to the follow-up change).
- Save-time conflict surfacing / `memory.judge` (deferred to the follow-up change).
- Cross-actor / cross-session merge reconciliation. Sessions are append-only here.
- Cloud sync of sessions between machines. The session row lives on whatever node hosts the database, same as memories.
- Semantic / fuzzy resolution of project slugs. Project resolution is strict exact-match. Typo suggestions use deterministic Levenshtein, not embeddings — see Decision 11.
- Backfilling `session_id` on memories created before this change. Existing rows keep `session_id = NULL` and remain queryable through every tool unchanged.

## Capabilities

### New Capabilities

- `sessions`: lifecycle of agent sessions — start, end, summarize — with append-only semantics, optional project scoping, agent identifier provenance, and foreign-key anchoring of memories and confirmations to their origin session.

### Modified Capabilities

- `mcp-api`: three session-lifecycle tools, three research tools, two observability tools, and three project-management tools added; descriptions of the four existing tools rewritten in "protocol-teaching" style; the `instructions` block ships protocol guidance at handshake; the `X-Rembric-Project` header is removed from the scope-resolution path.
- `projects`: identity column renamed from `path` to `slug` with a strict normalization rule for new slugs; `findOrCreate(path)` is replaced by `findBySlug` + explicit `create({slug})`; auto-detection via MCP `roots` resolves an existing slug but never creates.
- `dashboard`: new `/dashboard/sessions` list + detail views; session count surfaces on the home overview; the projects page surfaces slugs (the new identity) and flags legacy slugs that do not match the strict regex.
