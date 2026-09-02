## Why

Agents barely use `memory.search` because every recall trigger is reactive — it fires only when the user says "remember", "recall", or "what did we do". The keyword regex `RECALL_REGEX` (`/remember|recall|acuérdate|qué hicimos|what did we do/i`) never fires on new-task prompts like "set up the auth module" or "debug this timeout", which are the moments where prior work would save the most. The search quality itself is solid — `pnpm run eval` on a 70-row corpus yields hybrid P@8=0.212, R@8=0.975, MRR@8=0.917 — but that retrieval is only available when something triggers it.

Three gaps compound: (1) the `memory.search` tool description lists only reactive triggers ("whenever the user references past work or asks 'remember', 'recall', 'what did we do'"), (2) the `RECALL` line in `instructions.ts` BASE is equally reactive ("Starting/resuming, after /compact, or asked what did we do"), and (3) the first-prompt prefetch fires once per session and never again — long sessions drifting to new topics never recall. The entity-matching engine (`extractEntities()` + `repos.entities.findMemoriesByEntity()`) already exists and is unexploited between the first prompt and the next `/compact`.

## What Changes

- **Proactive trigger wording replaces reactive-only wording.** The `SEARCH_DESCRIPTION` in `apps/server/src/mcp/server.ts` (1857/1900 chars; DESCRIPTION_MAX_LENGTH=1900, CI-enforced) gets its trigger list swapped from reactive keywords to proactive moments: before starting work in an area untouched this session, before diagnosing a possibly-known error, before building something that may already exist. Same swap in the `RECALL` line of `instructions.ts` BASE (621/1000 chars). Both must respect their length budgets; wording is reclaimed, not appended.
- **Entity recall hints at turn START via a dedicated endpoint.** A new lightweight `POST /api/<slug>/sessions/:id/recall-hints` endpoint accepts `{prompt}` (already `<private>`-redacted client-side, server processes at most the first 500 chars), extracts entities, matches the entity index, and returns `{lines: string[]}`. Read-only and process-and-discard: the prompt is never persisted (append-only invariant). Clients call this synchronously before the model responds — pi via `before_agent_start`, opencode via `chat.message`, bash via a dedicated matcher-less `prompt-hints.sh` entry — and merge the returned lines into the model's context so they are visible from the first token. The turn body stays `{usedTools}` (+title) exactly as today.
- **Minimal usage observability.** Server-side counters of tool calls (at minimum `memory.search` / `memory.context` / `memory.save`) per token/client, so the improvement is measurable rather than assumed. Minimal surface; dashboard display optional.

## Capabilities

### New Capabilities

- `proactive-recall`: Server-side entity extraction from the turn prompt, entity-index matching, per-session dedup, ≤3 recall-line composition delivered via the dedicated recall-hints endpoint at turn start; minimum usage counters per tool call.

### Modified Capabilities

- `mcp-api`: The `memory.search` tool description trigger list changes from reactive-only to proactive-moment wording (content obligation within DESCRIPTION_MAX_LENGTH). A new `POST /sessions/:id/recall-hints` endpoint replaces the original plan to add a `prompt` field to the turn body.
- `session-nudges`: Recall lines now arrive at turn start via the hints endpoint, not via next-turn pending lines on the turn channel. The turn body stays `{usedTools}` as today. The server-composed / client-composed boundary is updated to reflect the new transport.
- `plugin-session-protocol`: Client call sites invoke the hints endpoint at turn start (pi `before_agent_start`, opencode `chat.message`, bash `prompt-hints.sh`). The turn-report body retains only `{usedTools}` (+title); the `prompt` field is no longer part of the turn report.

## Impact

**Server.**

- `apps/server/src/mcp/server.ts` — `SEARCH_DESCRIPTION` wording swap within 1900-char cap.
- `apps/server/src/mcp/instructions.ts` — `RECALL` line wording swap within 1000-char cap.
- `apps/server/src/server/api-router.ts` — new `POST /sessions/:id/recall-hints` endpoint accepting `{prompt}`, returning `{lines: string[]}`. The `/sessions/:id/turn` handler is unchanged.
- `apps/server/src/services/agent-sessions.ts` — `recallHints` function: extract entities from first 500 chars, match index, filter to project/feedback/procedural, dedup per session, cap at 3 lines; new usage counters.

**Plugin.**

- `apps/plugin/bin/rembric-plugin-core.mjs` — new `recallHints()` call in `before_agent_start` / `chat.message` path; hints merged into result alongside existing nudgesForTurn output. Turn body unchanged.
- `apps/plugin/scripts/prompt-hints.sh` — the dedicated matcher-less hook that calls the hints endpoint synchronously and echoes returned lines before the model responds. `prompt-search.sh` is deliberately left byte-for-byte request-free: `claude-code-plugin` publishes that it performs no query and its emitted text is corpus-independent, and dropping a published scenario is not available to this change.
- `apps/plugin/scripts/_api.sh` — `rembric_recall_hints` function with bounded timeout.
- `apps/plugin/test/nudge-fixtures.json` — recall fixture updated for new wording.

**Tests.**

- `apps/server/src/test/mcp-integration.test.ts` — CI test for DESCRIPTION_MAX_LENGTH wording.
- `apps/plugin/test/hook-manifests.test.ts` — nudge fixture assertions.
- `apps/server/src/test/` — hints endpoint unit tests (entity extraction, dedup, no-persistence); zero-delay integration test (hint lines present in the SAME turn response to the model).

**Invariants touched:** append-only (no prompt persistence — the hints endpoint extracts and discards the prompt within the request handler, never writes to any table); service-layer scope (entity extraction respects project scope via `projectScope()`); no new SQL outside `apps/server/src/db/` (entity tables already exist; dedupe state is in-memory/transient). Nudge text changes stay in sync with `nudge-fixtures.json` and `prompt-search.sh` conventions.
