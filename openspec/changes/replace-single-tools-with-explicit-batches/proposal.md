## Why

Four MCP operations currently expose incompatible single-item and batch forms. Explicit batch-only tools make discovery and usage uniform without increasing the tool count, while preserving the richer memory read and all project-isolation and mutation guarantees.

## What Changes

- **BREAKING** Replace `memory.get`, `memory.session_get`, `memory.confirm` and `memory.judge` with `memory.get_batch`, `memory.session_get_batch`, `memory.confirm_batch` and `memory.judge_batch`. Remove original registrations; no aliases.
- Require explicit `ids` for confirmations and `judgments` for judgments. Both memory and session reads accept IDs or `from`/optional `to` directly, mutually exclusive. Memory periods select immutable creation time; session periods select activity spans. One-element arrays replace individual calls.
- Paginate reads with limit (default/max20) and offset, returning total/nextOffset and complete content; no new byte/token budget, fragmentation or cursors. Cap mutation calls at20 items without automatic splitting.
- Return ordered, deduplicated reads with successful data and associated per-item errors, complete session summaries and per-memory history, head and confirmation metadata. Mark the MCP call as an error when no item succeeds, including a one-item batch.
- Preserve atomic confirmation batches and independent judgment outcomes; mark all-failed judgment batches as MCP errors while retaining per-item results. Retain project authorization and existing history/annotation bounds.
- Count every successfully returned memory batch record as access, for batches of one or many; advance the resolved head's access signal without treating reading as affirmation.
- Migrate MCP initialize instructions, schemas/descriptions, documentation, embedded prompts, recovery reminders, weekly-query examples and tests across all five plugins as a completion gate.
- Keep context budgeting, Pi compaction recovery, save idempotency and timing diagnostics out of this change.

## Capabilities

### New Capabilities

- `explicit-batch-tools`: canonical batch-only names, collection contracts, preserved read metadata and client migration.

### Modified Capabilities

- `mcp-api`: replace the four registrations, input/output schemas and single-item forms; retain annotation budgets.
- `sessions`: replace single-session MCP retrieval with scoped batch retrieval of full summaries.
- `memory`: apply dereference access semantics to all successful batch targets while preserving review-state, search and history invariants.
- `plugin-session-protocol`: recovery reminders use the batch read before summary writes.
- `pi-plugin`: discovered batch tools retain underscore-safe host names and forward array arguments unchanged.

## Impact

Server: `packages/mcp/src/{server,memory-tools,session-tools,relations-tools,instructions}.ts`; shared history assembly in `packages/core/src/services/memory.ts`. Clients: `apps/plugin/bin/rembric-plugin-core.mjs`, `apps/plugin/scripts/{post-compact,prompt-nudge}.sh`, `.hermes-plugin/__init__.py`, `.opencode-plugin/plugin.ts`, `.pi-plugin/index.ts`, shared commands, fixtures, guides and associated tests. No dependencies. Additive index migrations are permitted only after measured, reproduced query evidence. Append-only memory, service-layer scope, topic convergence, fresh-context judgment, confirmation attribution and HTTP session lifecycle remain unchanged. Operators must upgrade server and plugins together; stale clients receive unknown-tool or strict-input errors, never silent compatibility behavior.
