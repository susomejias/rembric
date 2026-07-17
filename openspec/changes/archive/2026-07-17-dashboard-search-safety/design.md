## Context

Two independent operator-facing bugs, grouped because both are dashboard/search-surface robustness fixes of similar size and risk, and both were already implemented and tested before this design doc was written (following the same discipline as the two prior changes this session).

## Goals / Non-Goals

**Goals:**

- Close the stored-XSS hole in `sessions.ts` (prompt tags, legacy project slugs).
- Make every FTS5 `MATCH` call site reachable by untrusted/operator-typed text go through the existing `sanitizeFtsQuery`, matching `memory.search`'s already-correct convention.
- Preserve the dashboard search boxes' UX: the operator should see back what they typed, not the internal `"term" OR "term"` match expression.

**Non-Goals:**

- Not auditing every `raw()` call site in the dashboard for the same class of bug (scoped to the two concrete reports, #252 and #258); a grep-based invariant test to prevent regressions is a separate, later hardening task, not part of this change.
- Not changing `memory.search`'s existing sanitization (already correct) — only extending the same pattern to the sites that lacked it.

## Decisions

### D1. Escape at the render site, mirroring the existing correct pattern

`memories.ts:427` already does `raw(\`<span class="pill">${escape(t)}</span>\`)`for memory tags.`sessions.ts`'s prompt-tags and `projectSlug`interpolations get the identical treatment —`escape()`imported from`templates.ts`(the same module`memories.ts` sources it from). No new abstraction; the fix is exactly as wide as the two broken call sites.

**Alternative considered:** a shared `codeTag(value)` helper that always escapes, removing the footgun class-wide. Rejected for this change — it's a larger refactor (would touch every `raw(<code>...)` call site in the dashboard) better suited to a dedicated hardening pass with its own regression test, not bundled into a two-line bug fix.

### D2. Sanitize at the caller, not inside the repository

`sanitizeFtsQuery` lives in `services/hybrid-search.ts` (a service-layer pure function). Repository methods (`PromptsRepository.searchByScope`, `adminSearchFts`; `MemoryRepository.adminSearchFts`) must not import from `services/` — that would invert the data-access dependency direction (`data-access` capability: services depend on repositories, never the reverse). So sanitization happens at each _caller_:

- `PromptsService.searchByScope` — the MCP-facing service method — sanitizes before calling `this.repos.prompts.searchByScope`.
- `dashboard/prompts.ts` and `dashboard/memories.ts` — sanitize immediately after reading `q` from the URL, before either dashboard page's `if (query) { ...adminSearchFts... }` branch decision.

This mirrors the existing convention in `hybrid-search.ts`'s `lexicalRetriever`, which sanitizes before calling `repos.memory.searchBm25Ids`.

### D3. Split raw vs. sanitized query in the two dashboard pages

Sanitizing overwrites the query text (`alpha beta` → `"alpha" OR "beta"`). If the dashboard redisplayed the _sanitized_ value in the search `<input>`, the operator would see a value they never typed — confusing and inconsistent with every other filter control on the page, which redisplay exactly what was submitted. Fix: keep two bindings —

```ts
const rawQuery = url.searchParams.get('q') ?? ''; // redisplayed in the <input>
const query = sanitizeFtsQuery(rawQuery); // used for MATCH + the if(query) branch check
```

The `if (query)` branch-selection check intentionally uses the _sanitized_ value: if the operator's input sanitizes to nothing (pure punctuation), the page falls back to the plain recency/list view — the same outcome as submitting no query at all — rather than calling `adminSearchFts('')`, which would be meaningless.

### D4. `memory.search_prompts`'s empty-after-sanitize case falls back to recency, matching `memory.search`

`PromptsService.searchByScope`'s repository call decides FTS-vs-recency via `typeof opts.query === 'string' && opts.query.trim().length > 0`. Passing `sanitized || undefined` when sanitization empties the string routes it into the existing recency branch — the same "caller skips the branch" contract `sanitizeFtsQuery`'s own doc comment describes, already used by `hybrid-search.ts`.

## Risks / Trade-offs

- **[Other `raw()` sites might have the same escaping gap]** → out of scope here (see Non-Goals); worth a follow-up grep-based invariant test, tracked separately rather than blocking this fix.
- **[Sanitization changes what an admin's literal FTS5 query syntax does]** (e.g. a `title:x` column filter, if anyone relied on it) → `sanitizeFtsQuery` already strips such syntax for `memory.search`; extending the same behavior to prompts search is a net hardening, and no code path or documentation ever advertised raw FTS5 syntax as supported here.

## Migration Plan

No migration — code-only, no schema change. Rollback is a plain revert (no data implications).
