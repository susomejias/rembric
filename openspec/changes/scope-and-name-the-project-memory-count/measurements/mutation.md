# Mutation runs (task 3)

All runs from the repo root on 2026-08-03 via `node scripts/mutate.mjs`. `mutate.mjs`
reported `baseline: … green` before every run, so nothing below is a pre-existing
failure. No `-t` filter was used, so a mutation caught by some OTHER test in the
spec would also have shown.

`find` strings are adapted to the code actually landed (task 3's own instruction).
Two adaptations are worth naming:

- Task 3.1's illustrative `find` (`eq(memory.status, 'active')`) matches **7×** in
  `memory-repository.ts`, and `mutate.mjs` skips — and counts as uncovered — any
  `find` that does not match exactly once. Verbatim: `SKIP (matched 7×, need
exactly 1): eq(memory.status, 'active')`. The whole `where(...)` argument of the
  new method is unique, so both 3.1 and 3.2 use it as the `find` and weaken exactly
  one of its two conjuncts in the `--with`.
- Task 3.2's illustrative `--with` (`isNotNull(memory.projectId)`) needs an import
  the landed code no longer has (`isNotNull` became unused when `countByProject`
  went, so lint required its removal). The equivalent `sql` fragment reproduces the
  old unscoped predicate with only already-imported symbols.

## 3.1 — the `status` condition, alone

`--file apps/server/src/db/repositories/memory-repository.ts`
`--mutation "and(scopeCondition(scope, projectId), eq(memory.status, 'active'))"`
`--with "scopeCondition(scope, projectId)"` (scope kept, status dropped)

Against `--spec src/test/mcp-integration.test.ts`:

```
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ src/test/mcp-integration.test.ts:1665:50
    1665|     expect(entryFor(after, P).activeMemoryCount).toBe(0);

mutation: and(scopeCondition(scope, projectId), eq(memory.status, 'active'))
  CAUGHT by 1:
    × MCP protocol conformance > project.list's activeMemoryCount drops when a memory is archived, and is per-project
```

Against `--spec src/mcp/authorization.test.ts` (independent second suite, where the
count-vs-row-count distinction is asserted separately: A holds 2 active + 1 archived):

```
-     "activeMemoryCount": 2,
+     "activeMemoryCount": 3,

mutation: and(scopeCondition(scope, projectId), eq(memory.status, 'active'))
  CAUGHT by 3:
    × project.list is filtered by token scope > a `*` token sees every project with its own count
    × project.list is filtered by token scope > a `read:*` token sees every project with its own count
    × project.list is filtered by token scope > a `project:<id>` token sees only that project, and no count is taken for the other
```

## 3.2 — the **scope** condition, alone

Same `find`; three `--with` variants, each keeping `status = 'active'` intact.

**3.2a — the exact pre-change predicate** (`--with "and(sql\`${memory.projectId} IS NOT
NULL\`, eq(memory.status, 'active'))"`), i.e. every project's rows count into every
project's entry:

```
AssertionError: expected 5 to be 1 // Object.is equality
 ❯ src/test/mcp-integration.test.ts:1653:51
    1653|     expect(entryFor(before, P).activeMemoryCount).toBe(1);

  CAUGHT by 1:
    × MCP protocol conformance > project.list's activeMemoryCount drops when a memory is archived, and is per-project
```

Against `--spec src/mcp/authorization.test.ts`:

```
  CAUGHT by 4:
    × project.list is filtered by token scope > a `*` token sees every project with its own count
    × project.list is filtered by token scope > a `read:*` token sees every project with its own count
    × project.list is filtered by token scope > a `project:<id>` token sees only that project, and no count is taken for the other
    × project.list is filtered by token scope > a `read:project:<id>` token sees only that project, and no count is taken for the other
```

**3.2b — no scope predicate at all** (`--with "eq(memory.status, 'active')"`), which
also admits global rows:

```
AssertionError: expected 37 to be 1 // Object.is equality
 ❯ src/test/mcp-integration.test.ts:1653:51
  CAUGHT by 1:
    × MCP protocol conformance > project.list's activeMemoryCount drops when a memory is archived, and is per-project
```

**3.2c — global widening only**, project isolation preserved (`--with
"and(scopeWhere(scope, projectId, undefined, true), eq(memory.status, 'active'))"`).
Run because 3.2a leaves global rows excluded and therefore does NOT exercise the
global-exclusion assertion the task names:

```
AssertionError: expected 33 to be 1 // Object.is equality
 ❯ src/test/mcp-integration.test.ts:1653:51
  CAUGHT by 1:
    × MCP protocol conformance > project.list's activeMemoryCount drops when a memory is archived, and is per-project
```

Honest note on which assertion did the work in 3.2b/3.2c: the test asserts P's count
as an **absolute** 1 before the archive, and that fires before the later
global-specific re-list. The absolute assertion strictly subsumes the delta check, so
global exclusion is covered — but the line that reddens is `:1653`, not the
global-row block.

## 3.3 — the authorization filter must stay ABOVE the counting

**3.3a — the filter removed** (`--file apps/server/src/mcp/project-tools.ts`,
`--mutation ".filter((p) => isAuthorized(ctx.scope, 'read', { scope: 'project',
projectId: p.id }))" --with ""`):

```
  CAUGHT by 2:
    × project.list is filtered by token scope > a `project:<id>` token sees only that project, and no count is taken for the other
    × project.list is filtered by token scope > a `read:project:<id>` token sees only that project, and no count is taken for the other
```

This reddens on the row set, which the pre-existing slug assertions already covered.
It does not on its own prove the **ordering**, so a second, sharper mutation was run.

**3.3b — the filter turned into a post-filter**: rows counted first, then the mapped
entries filtered by the same predicate. The response payload is **byte-identical** to
the correct one, so only an ordering assertion can catch it:

```
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
  Array [
+   "project:01KZ40AJMYDR0PZ8VQQ3DYWMGV",
    "project:01KZ40AJMYZ4J6QY739VV1S2Z4",
  ]
 ❯ src/mcp/authorization.test.ts:433:24
    433|     expect(scopesRead).toEqual([`project:${projectB.id}`]);

  CAUGHT by 2:
    × project.list is filtered by token scope > a `project:<id>` token sees only that project, and no count is taken for the other
    × project.list is filtered by token scope > a `read:project:<id>` token sees only that project, and no count is taken for the other
```

The payload assertion at `:430` **passed** under 3.3b; the failure is at `:433`, the
`scopesRead` spy over `MemoryRepository.countActiveInScope`. That is the requirement
"the read SHALL be invoked for `p`'s scope and SHALL NOT be invoked for `q`'s scope"
failing on its own terms, with an unchanged payload — which is the whole content of
design D2.

## 3.4 — the description clause

`--file apps/server/src/mcp/server.ts --spec src/test/mcp-integration.test.ts`
`--mutation 'Each entry carries activeMemoryCount — how many memories in that project
are still active; archived and superseded rows are not counted. ' --with ''`

```
AssertionError: expected 'List existing projects. Use when the …' to contain 'activeMemoryCount'
Expected: "activeMemoryCount"
Received: "List existing projects. Use when the user references a project that may not be active in this session."
 ❯ src/test/mcp-integration.test.ts:320:18

  CAUGHT by 1:
    × MCP protocol conformance > project.list description says the per-project count covers active memories
```

Note the residual `/active/i` match in "active in this session" — that is why the test
also asserts `activeMemoryCount` and `/archived/i`, and why the `/active/i` assertion
alone would have been green on both sides.

## Summary

| Task | Condition weakened                       | Result                                                    |
| ---- | ---------------------------------------- | --------------------------------------------------------- |
| 3.1  | `status = 'active'`                      | CAUGHT — 1 test (integration) + 3 tests (authorization)   |
| 3.2a | scope → pre-change `project_id NOT NULL` | CAUGHT — 1 test (integration) + 4 tests (authorization)   |
| 3.2b | scope predicate removed entirely         | CAUGHT — 1 test (integration)                             |
| 3.2c | scope widened to include global rows     | CAUGHT — 1 test (integration)                             |
| 3.3a | authorization filter removed             | CAUGHT — 2 tests (authorization), on the row set          |
| 3.3b | authorization filter → post-filter       | CAUGHT — 2 tests (authorization), on the `scopesRead` spy |
| 3.4  | description's active-memory clause       | CAUGHT — 1 test (integration)                             |

`mutate.mjs` reported `all 1 mutations caught; <file> restored` on every run, and
`git diff --stat` after the batch matched the diffstat before it.
