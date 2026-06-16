## Why

`memory.search` now ranks by hybrid semantic + keyword retrieval (dense ⊕ FTS5 via RRF) and returns a small default page of 8, but its MCP tool description has not kept up: it still says "FTS5 keyword search" (stale and misleading — it hides the cross-lingual/paraphrase capability the project just shipped) and gives the agent no hint that the page is small by default and can be widened. An agent that receives 8 all-relevant rows has no signal that it may ask for more. Tool descriptions are the only interface an LLM client reads, so a stale one degrades real usage.

## What Changes

- Update `SEARCH_DESCRIPTION` to advertise **hybrid semantic + keyword ranking** (so paraphrases and cross-lingual queries are known to match) instead of the stale "FTS5 keyword search".
- Add a **widen affordance** to the description: results are a small default page (8); if all results look relevant and more are needed, call again with a higher `limit` (up to 200) or page with `offset`.
- Add zod `.describe()` text to the `limit` and `offset` params in `memorySearchSchema` (currently bare numbers) so the affordance is visible in the input schema too.
- Preserve the existing "Call this WHEN the user references past work / recall" trigger — it is not removed, only built upon.
- No behavior change: description and input-schema copy only. Request/response shapes, ranking, and clamping are untouched.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-api`: the requirement "The four existing memory tools MUST advertise protocol-teaching descriptions" gains an additional contract — the `memory.search` description SHALL advertise hybrid semantic+keyword ranking and the small-default/widen-via-`limit`-or-`offset` affordance, alongside (not replacing) the existing recall trigger.

## Impact

- `apps/server/src/mcp/server.ts` — `SEARCH_DESCRIPTION` string.
- `apps/server/src/mcp/tools.ts` — `memorySearchSchema` `limit`/`offset` `.describe()`.
- Tests: `apps/server/src/mcp/instructions.test.ts` (or wherever the description-trigger CI assertion lives) — add assertions for the new wording.
- Spec: `openspec/specs/mcp-api/spec.md`.
- Complements the just-merged default-20→8 change (PR #170); the "8" wording is consistent with main.
- No migration, no tool-shape change, no dashboard change.
