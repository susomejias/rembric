# Correct the surfaces that still say four clients

## Why

Adding Pi made the repo a five-client project, but four surfaces still say four, and `add-pi-plugin` shipped with its own acceptance scenario unsatisfied:

> `pi-plugin/spec.md:402` — **Scenario: No surface still claims four clients**: `git grep -in "four clients\|FOUR clients\|all four"` over tracked files, excluding `openspec/changes/archive/**` — every remaining occurrence SHALL be either historically scoped or corrected to the current count.

That grep returns 28 hits at HEAD. Most are legitimate and stay: `all four indexes`, `all four columns`, `all four arguments`, `all four memories`, `all four phases`, the two CHANGELOGs (historically scoped by definition), and `claude-code-plugin/spec.md:80`'s `across all four`, which counts slash commands. `apps/plugin/.pi-plugin/README.md:7` also stays: from Pi's own README, "the other four clients" is the correct count.

Three spec lines are genuinely stale, plus one layout list that predates Pi and simply omits it.

One of the stale surfaces is not prose. `apps/server/src/mcp/server.ts:298` is the `memory.session_start` description, which every agent reads from `tools/list` on every session:

> `the host registers the session automatically (Claude Code/Codex hooks and the Hermes/opencode providers POST to the sessions endpoint on startup)`

Pi registers its session too — `apps/plugin/.pi-plugin/index.ts:294` calls `core.ensureSession`. So a Pi agent reading this concludes its host does not, and may call `memory.session_start` when it should not. This is the only stale surface a model consumes at runtime, which is why it leads the task list.

It also contradicts a requirement that is already correct and client-agnostic — `mcp-api/spec.md:535`: _"every supported host registers the session over HTTP before the agent runs"_. The code is the outlier; no new requirement is needed for it, only alignment.

## What changes

- `apps/server/src/mcp/server.ts` — the `memory.session_start` description names Pi. The "on startup" clause goes: it is accurate for the hook-based clients and wrong for the in-process ones, which POST on the first prompt.
- `apps/server/src/mcp/summary-rubric.ts:4` — the comment says "bash, Python and the opencode plugin keep their own copies" of the rubric. The `add-pi-plugin` extraction moved that copy into the shared core; `invariants.test.ts` now pins `REMBRIC_PLUGIN_CORE_MJS`, not the opencode plugin. The comment points a reader at the wrong file.
- `openspec/specs/http-api/spec.md:44` — "all four supported agents" → "every supported agent".
- `openspec/specs/mcp-api/spec.md:1559` — "all four supported clients" → "every supported client".
- `openspec/specs/mcp-api/spec.md:539` — "two of the four clients" → "two of the clients".
- `openspec/specs/development-environment/spec.md:381` — the `apps/plugin/` description lists four clients; Pi joins them.

Count-free phrasing where the sentence does not depend on the number, so the next client added does not reopen the same four files.

## Open question this change deliberately does not answer

`mcp-api/spec.md:539` says `abandoned` is the documented steady state for **two** of the clients. Whether Pi is now a third is unverified: it would depend on whether Pi's shutdown path reaches `memory.session_end`, and measuring that is not in scope here. Dropping the stale total while keeping the verified "two" removes a number known to be wrong without asserting a new one. If Pi does belong in that set, "two" is the next thing to correct — flagged, not guessed.

## What this change does not do

It adds no mechanical enforcement of the "no surface still claims four clients" scenario. Enforcing it would need an allow-list of the ~25 legitimate `all four <noun>` hits plus a client-name-to-prose mapping, and both drift on their own. A guard that needs maintaining to stay true is worse than the grep the scenario already specifies. Recorded as a rejected option rather than left implicit.

## Impact

No behaviour change beyond one tool description an agent reads. No schema, no migration, no MCP tool added or removed. `DESCRIPTION_MAX_LENGTH` is 1900 and the description is 624 characters, so the edit has ample headroom — but the assertion in `mcp-integration.test.ts` is what confirms it, not this estimate.
