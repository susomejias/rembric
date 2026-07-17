## Why

Two operator-facing dashboard surface bugs, both already fixed and tested: prompt tags and legacy project slugs were rendered via `raw()` without `escape()` (stored XSS reachable by any project-scoped token via `memory.save_prompt`), and the dashboard's memory/prompts search boxes plus `memory.search_prompts` passed the operator's or agent's raw text straight into an FTS5 `MATCH`, which throws a syntax error on ordinary punctuation. Neither fix changes what the features do when given well-formed input — they close a security hole and a crash on malformed input.

## What Changes

- **Escape prompt tags and project slugs on `apps/server/src/dashboard/sessions.ts`.** Both `raw()` interpolations now go through `escape()`, matching the already-correct pattern used for memory tags elsewhere in the dashboard.
- **Sanitize free-text queries before they reach `... MATCH ?`.** `PromptsService.searchByScope` (backing `memory.search_prompts`), and the dashboard's memories and prompts admin search boxes, now run the query through the existing `sanitizeFtsQuery` (already used by `memory.search`'s hybrid retrieval) before it reaches any `prompts_fts`/`memory_fts` MATCH. In the two dashboard pages, the operator's unsanitized input is kept separately for redisplay in the search box, so the input doesn't show the transformed `"term" OR "term"` form back at them.

No breaking changes. No invariant changes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `dashboard`: ADD a requirement that user-supplied text rendered outside the Markdown pipeline (prompt tags, project slugs, and any future `raw()` interpolation of untrusted data) MUST be HTML-escaped. ADD a requirement that the memories and prompts admin search boxes MUST sanitize the query before it reaches FTS5 `MATCH`, and MUST redisplay the operator's original input (not the sanitized form) in the search field.
- `mcp-api`: MODIFY the `memory.search_prompts` requirement to state that `query` is sanitized before reaching `prompts_fts MATCH` (mirroring the existing sanitization guarantee on `memory.search`'s hybrid retrieval), so a malformed query degrades to no lexical match rather than raising an error.

## Impact

- `apps/server/src/dashboard/sessions.ts` — `escape()` on the prompt-tags and `projectSlug` interpolations.
- `apps/server/src/services/prompts.ts` — `searchByScope` sanitizes `input.query` via `sanitizeFtsQuery` before calling the repository.
- `apps/server/src/dashboard/memories.ts`, `apps/server/src/dashboard/prompts.ts` — split `rawQuery` (redisplayed) from `query` (sanitized, used for `MATCH` and the FTS-branch/recency-branch selection).
- Issues: #252, #258.
