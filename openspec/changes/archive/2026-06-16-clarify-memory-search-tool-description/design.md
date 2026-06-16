## Context

`memory.search`'s tool description (`SEARCH_DESCRIPTION` in `apps/server/src/mcp/server.ts`) is the only thing an MCP client reads to decide how to call it. It currently says "Supports FTS5 keyword search + type/tag/status/limit filters" — written before hybrid search and the 8-result default landed. The `limit`/`offset` params in `memorySearchSchema` are bare zod numbers with no `.describe()`. The mcp-api spec already pins that each tool description must teach a "Call this WHEN …" trigger (and a CI test enforces it).

## Goals / Non-Goals

**Goals:**

- The description accurately advertises hybrid semantic + keyword ranking (cross-lingual/paraphrase capable).
- The agent knows the default page is small and how to get more (higher `limit`, or `offset`).
- The existing recall trigger is preserved (and its CI assertion keeps passing).

**Non-Goals:**

- Any behavior change to ranking, clamping, filters, or response shape.
- Re-opening the default value (8) or the deferred cosine floor — out of scope.

## Decisions

**D1 — Build on the existing trigger, do not replace it.** The spec and a CI test require the "Call this whenever the user references past work / recall" wording in the `memory.search` description. The new wording is added around it, not in place of it.

**D2 — Advertise capability, not implementation detail.** Say "hybrid semantic + keyword relevance (vector similarity ⊕ FTS5)" so the agent understands paraphrases/cross-lingual match — without leaking tunables (RRF constant, rank window) that the agent cannot act on.

**D3 — State the affordance concretely.** "Returns a small default page (8); call again with a higher `limit` (up to 200) or page with `offset`." The concrete numbers (8, 200) match the implemented clamp so the description cannot drift from behavior silently; a future default change would update both.

**D4 — Mirror the affordance in the input schema.** Add `.describe()` to `limit`/`offset` so a client that renders parameter help (not just the tool description) also sees it.

## Risks / Trade-offs

- **The "8"/"200" literals in prose can drift from `DEFAULT_SEARCH_LIMIT`/the clamp ceiling.** Accepted: a description is documentation, and the new CI assertions only check for the affordance wording, not the exact digits, so a future default change is a one-line copy edit, not a test break. (If drift becomes a real problem, interpolate the constants into the string — deferred as overkill for two literals.)
- **Description length grows.** Minor; still a single sentence-group, well under any client truncation.
