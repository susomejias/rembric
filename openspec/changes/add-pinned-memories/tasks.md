## 1. Persistence

- [ ] 1.1 Migration `0041_memory_pin_events.sql`, Drizzle schema, index snapshot and schema inventory; boot gates expect 41 migrations.
- [ ] 1.2 Memory-repository pin reads (latest action per id, pinned list and count per project, pin history, admin filter) and the event insert.
- [ ] 1.3 Purge predicate: a pin event blocks the purge (RED first).
- [ ] 1.4 Invariant test: no UPDATE or DELETE of `memory_pin_events` outside the dev seed reset.

## 2. Service

- [ ] 2.1 RED: pin, unpin, idempotence, cross-scope, non-active, count bound (with control), per-project bound.
- [ ] 2.2 GREEN: `MemoryService.setPinned`, `listPinned`, `pinnedIdsAmong`, `PIN_MAX_PER_PROJECT`, `pin_limit_reached`.
- [ ] 2.3 RED then GREEN: `applyRetirementEffects` releases pins on topic_key revision, supersedes verdict, merge, archive, decay and merge undo; topic_key upsert carries the pin; undo does not restore it; review axis unchanged.

## 3. MCP

- [ ] 3.1 `memory.pin` schema, output, handler, registration and steering description; catalog wiring (write tools, minimal args, authorization).
- [ ] 3.2 `memory.context.pinnedMemories[]` first, budget truncation, dedupe without quota loss; `PINNED_CONTEXT_CHAR_BUDGET`.
- [ ] 3.3 `pinned` on `memory.search` and `memory.get_batch` rows; `memory.stats.pinnedTotal`.
- [ ] 3.4 Docs that list the tool catalog.

## 4. Dashboard

- [ ] 4.1 List badge, `pinned` filter with exact total, row pin/unpin action.
- [ ] 4.2 Detail pin state, pin/unpin Server Actions, pin history, refusal message.

## 5. Close

- [ ] 5.1 Mutation check each bound and the dedupe and scope guards with `scripts/mutate.mjs`.
- [ ] 5.2 `pnpm run eval` ratchet green; `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.
