## Why

`memory.context` composes a session opening from two ranked channels, recency and relevance to the first prompt ("`memory.context` MUST offer a relevance channel alongside recency"). Neither lets the operator or the agent say _these few memories must be loaded every time_. The memories that most need that guarantee are the standing rules of a project: `procedural` how-tos, `feedback` corrections and the handful of `project` facts every task depends on. Today they compete with whatever happened recently, so a rule saved months ago and not touched since drops out of the opening exactly when a fresh session is most likely to violate it (issue #448).

## What Changes

- **New lifecycle state: pinned.** An `active` memory MAY be pinned. Pin state is derived at read time from a new append-only journal table, `memory_pin_events`, never stored as a mutable column: pinned means the memory is `active` and its latest pin event is `pin`. Pin and unpin are reversible, journaled events in the same family as confirmations; no `memory` row is updated by pinning.
- **New MCP tool `memory.pin`** taking `{ id, pinned: boolean }`. Idempotent (a call that changes nothing writes nothing), scope-bounded through the shared resolver, write-classified. Its description steers against autonomous pinning, as `memory.archive`'s does: the agent pins only at the user's explicit request. The dashboard is unrestricted.
- **Bounded size.** Two named constants beside the other retrieval constants: `PIN_MAX_PER_PROJECT` (10) and `PINNED_CONTEXT_CHAR_BUDGET` (4000). Pinning past the count is refused with the structured error `pin_limit_reached`, whose details name every current pin. Content past the budget is display-truncated with the existing context snippet bound and flagged, and the agent is pointed at `memory.get_batch` for the full text. The count applies to every caller, the dashboard included.
- **`memory.context` leads with `pinnedMemories[]`**, emitted before every other section, outside the recency and relevance quotas. A pinned memory is not repeated in `recentMemories[]` or `relevantMemories[]`, and neither channel loses a slot to it. With no pins the two channels are unchanged.
- **Pin state is visible on reads**: a `pinned` boolean on `memory.search` and `memory.get_batch` rows, `pinnedTotal` on `memory.stats`, and a badge, a filter, a pin/unpin action and a pin history on the dashboard memory views.
- **Lifecycle interactions.** Superseding (topic_key revision, `supersedes` verdict, merge), archiving and decaying a pinned memory removes its pin with an `unpin` event naming the cause and, where the retirement has one, its journal run. A `topic_key` upsert carries the pin to the successor, because the topic is what was pinned. Undoing a retirement restores the memory, not its pin.
- **Review is not suspended.** A pinned memory still derives `needs_review` when its shelf life elapses and still appears in `memory.context.needsReview[]`.
- **Purge.** A memory with any pin event is connected by its journal and is not purgeable, so the pin journal stays append-only with no DELETE path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: ADDED "An active memory MAY be pinned, with pin state derived from an append-only journal"; MODIFIED "Memories MAY be physically purged when archived and disconnected" (a pin event blocks the purge).
- `mcp-api`: ADDED "The MCP server MUST expose `memory.pin`", "The `memory.pin` description MUST steer against autonomous pinning", "`memory.context` MUST lead with a bounded pinned section outside the ranked channels", "Memory-returning MCP reads MUST expose pin state"; MODIFIED "The MCP server MUST expose two observability tools" (`memory.stats` gains `pinnedTotal`).
- `persistence`: ADDED "The persistence layer MUST add an append-only `memory_pin_events` table".
- `dashboard`: ADDED "The memory views MUST show, filter and change pin state".

## Impact

- `packages/db`: migration `0041_memory_pin_events.sql`, schema, memory-repository pin reads and the event insert, index snapshot, purge predicate.
- `packages/core`: `MemoryService.setPinned` / `listPinned`, the bounds, the retirement side effect shared by every retirement path, the `topic_key` carry-forward.
- `packages/mcp`: `memory.pin` tool and catalog wiring, `memory.context` pinned section, `pinned` on read rows, `memory.stats.pinnedTotal`.
- `apps/web`: memories list badge and filter, detail pin/unpin action and pin history; migration count in the runtime-image and CI boot gates.
- Retrieval evaluation: pins sit outside the ranked channels and `memory.search` ranking is untouched, so the ratchet must not move.
- Plugins: none. Every client discovers tools through `tools/list`.
