## Why

`project.list` reports a number an agent cannot act on. `MemoryRepository.countByProject()` (`apps/server/src/db/repositories/memory-repository.ts:253-261`) is, verbatim on current `main`:

```ts
  /** Per-project active+total memory counts for the project list tool. */
  countByProject(): { projectId: string; n: number }[] {
    return this.db
      .select({ projectId: memory.projectId, n: count() })
      .from(memory)
      .where(isNotNull(memory.projectId))
      .groupBy(memory.projectId)
      .all()
      .filter((r): r is { projectId: string; n: number } => r.projectId !== null);
  }
```

Zero parameters — no `Scope`, no `projectId`. The only predicate is `isNotNull(memory.projectId)` (`:257`), so the query counts **every status** (`active` + `superseded` + `archived`) across **every project**, excluding only global rows. Its doc comment at `:252` promises "active+total memory counts"; the query implements **neither** dimension — there is no `active` filter and no separate total. Its immediate neighbour `countByStatusAndTypeInScope(scope, projectId)` at `:225-227` takes both parameters.

**Measured through the real MCP boundary** (in-process `createServer` driven by the official MCP SDK `Client` over `StreamableHTTPClientTransport`, two path-scoped connections, admin `*` token — the same harness shape as `apps/server/src/test/mcp-integration.test.ts`, so the zod schemas and the whole request-context path are in the loop). After `memory.archive` on a project's only memory:

```
PROBE after archiving A row => memoryCount 1  search hits 0
```

`project.list` reported `1` for that project while `memory.search` **in that same scope** returned `0`. That divergence — the count contradicting the corpus the agent can actually read, inside one scope, visible even to a project-scoped token — is the user-visible defect and the reason `active` is the right filter. Recorded in issue #310; not re-measured here.

The count reaches `project.list`'s response as `memoryCount` (`apps/server/src/mcp/project-tools.ts:212`, declared in `projectListOutput` at `:55`), from the sole call site `:202` inside `handleList` (`:193`), bound at `:79`, registered as the `project.list` tool at `apps/server/src/mcp/server.ts:431-440`.

**The name is where the ambiguity lives, and it is already overloaded inside this codebase.** `apps/server/src/db/repositories/agent-sessions-repository.ts:266` has a different `memoryCount`, meaning "memories saved in this session" (surfaced at `apps/server/src/services/agent-sessions.ts:604-606`). A bare `memoryCount` invites exactly the mismatch above: nothing in the name says which statuses it counts, so a reader has to open the query to find out, and the doc comment lies when they do.

The read also violates five recorded requirements, quoted verbatim:

- `openspec/specs/data-access/spec.md:39` — "Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. … Unscoped reads SHALL carry the `admin` name prefix and SHALL be invoked only from an allow-listed call site."
- `openspec/specs/data-access/spec.md:45` — "There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it and can be served from an agent-facing path while the invariant test passes — which is exactly how an unscoped session count reached `memory.stats`. Every unscoped repository read SHALL therefore carry `admin`, whatever it returns." `countByProject` is that same failure mode, one tool over: the `admin*` confinement gate (`apps/server/src/test/invariants.test.ts:623-679`) matches `\.(admin[A-Z]\w*)\(`, so it cannot see this call at all.
- `openspec/specs/data-access/spec.md:155` — "Every repository read reachable from the MCP layer SHALL take the `Scope` as a required parameter, so omitting it is a type error rather than a naming oversight. An unscoped variant SHALL exist only under the `admin` prefix, bringing it inside the confinement gate." This is the direct violation.
- `openspec/specs/data-access/spec.md:157` — "An MCP-reachable read MAY legitimately take no `Scope` — but only when the scoped alternative does not exist or is shown by MEASUREMENT to be unaffordable … 'Would be slower' is not the standard; the numbers and the instrument that produced them are." The escape hatch does **not** apply: a scoped alternative demonstrably exists (`countByStatusAndTypeInScope(scope, projectId)` at `memory-repository.ts:225`, over `scopeCondition(scope, projectId)` at `apps/server/src/db/repositories/scope-clause.ts:31-35`), and no measurement was ever recorded for this read.
- `openspec/specs/mcp-api/spec.md:885` — "the server SHALL return `{ projects: Array<{ slug, displayName, archived, memoryCount }> }` ordered by slug ascending, filtering archived rows by default". The contract names the field and is **silent on what it counts**; "filtering archived rows" there means archived **projects**, not archived memories. This silence is the delta's main target.

## What Changes

- **`memoryCount` is renamed to `activeMemoryCount` in `project.list`'s response and output schema.** **BREAKING** on the wire for any consumer parsing the old key. Chosen over keeping the key because the value changes anyway (archived and superseded rows stop counting): an unchanged key over changed semantics hides the change from every consumer, whereas a renamed key surfaces it at the first parse. Rejected alternative — keep `memoryCount` and only fix the query — is the strictly worse half of the fix, since it leaves the ambiguity that produced the defect and leaves the name colliding with `agent-sessions-repository.ts:266`. See design D5, which also explains why the mirror-image rename was _rejected_ for `memory.doctor` in `openspec/changes/archive/2026-08-02-say-which-population-the-doctor-counts/design.md` D2 and why that precedent does not transfer.
- **The count filters `status = 'active'`.** This is the behaviour change that closes the measured divergence: the number now matches what `memory.search` in the same scope can return. Rejected alternative — shipping both `activeMemoryCount` and a `totalMemoryCount` — see design D4: `memory.stats` already returns `memoriesByStatus` computed against the request context (`openspec/specs/mcp-api/spec.md:775`), so a second total on `project.list` would be a second, unscoped answer to a question already answered properly.
- **`countByProject()` is replaced by a scoped read that requires the scope as a parameter**, so omitting it is a type error rather than a naming oversight (`data-access/spec.md:155`). Shape and its trade-off in design D1; the primary shape is a per-scope count in the `*InScope` naming family, called once per authorized project row, chosen on clarity with the measurement left to the applier.
- **The new read carries no prefix.** It is neither `admin` (unscoped, allow-listed) nor `unsafe` (deliberately cross-scope) — it requires a `Scope` and reads exactly one. Naming it `admin*` would additionally require adding `mcp/project-tools.ts` to `ADMIN_CALL_SITES` (`invariants.test.ts:625-644`), i.e. putting an agent-facing MCP path on the unscoped-read allow-list, which is the opposite of the fix. Design D3.
- **`invariants.test.ts:726` is deleted in the same commit as the read it names.** The inventory asserts SET EQUALITY (`invariants.test.ts:693-697`: "both directions fail: an unlisted read, and a listed read that is gone"), so removing the violation without removing the entry reds the suite, and vice versa.
- **No number changes for any authorized row on the scope axis.** Verified by reading `handleList`, not assumed — see Impact. The scope fix is contractual, not a leak plug; the status filter is what changes the numbers.
- **No migration, no schema change, no new MCP tool.** One repository method, one handler, one output-schema field, one invariant-inventory line.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: modifies the `project.list` contract scenario (`openspec/specs/mcp-api/spec.md:882-885`) — renames the field to `activeMemoryCount` and, for the first time, states what the number counts and in which scope. The rename is a wire change to a declared `outputSchema`, so it must be spec-pinned rather than left to code.
- `data-access`: adds one scenario recording that this specific violation is closed and that the inventory entry went with it. No requirement text changes — the requirements at `:39`, `:45`, `:155` and `:157` were already right; the code disagreed with them. `:47`'s obligation to "mark any entry that is also a violation" is a conditional and stays exactly as written; after this change it is satisfied with zero such entries (`countByProject` is the only inventory line carrying a violation marker today — re-verified: `grep -n '//' ` over `invariants.test.ts:718-738` returns exactly that one line).

## Impact

**Durable invariants touched.** Two, both in the direction of compliance:

- **Scope enforced at the service layer** (`CLAUDE.md`) and the data-access confinement rules. An MCP-reachable read stops being unscoped. Note the honest nuance, recorded as design D2: `handleList` deliberately does **not** call `resolveEffectiveProject`/`scopeFromContext`, because `project.list` must keep working on a connection whose slug resolves to nothing — `openspec/specs/mcp-api/spec.md:85` requires that "`project.current`, `project.list`, `memory.about` … SHALL succeed" on `/mcp/no-such-project`, and `apps/server/src/mcp/unresolvable-slug.test.ts:233-246` pins it. The scope passed to the new read is therefore derived from the **already-authorized project row** (`('project', p.id)`), not from the caller's effective scope. That is sound only because `isAuthorized` runs upstream, which is why D2 makes the ordering a spec requirement and a mutation target rather than a comment.

Untouched: append-only memory (no row written, no `content` updated, no `DELETE`), `topic_key` convergence, fresh-context judgment, derived-never-stored review state, the consolidation sweep.

**Is the scoped rewrite output-preserving for every authorized row?** Read, not assumed. `handleList` (`apps/server/src/mcp/project-tools.ts:196-215`) filters project rows first — `.filter((p) => isAuthorized(ctx.scope, 'read', { scope: 'project', projectId: p.id }))` at `:198-200` — and then looks the count up by that row's own `p.id` at `:212`. `ctx.scope` is the **token** scope (`apps/server/src/server/request-context.ts:16`), and `isAuthorized` (`apps/server/src/services/tokens.ts:268-290`) admits a `project:<id>` / `read:project:<id>` token only for its own project. So a project-scoped token never saw another project's row and therefore never saw another project's count; `apps/server/src/mcp/authorization.test.ts:348-381` already pins all four token shapes. The only principal that ever saw every count is a `*` / `read:*` token, which is authorized for every project anyway. **Conclusion: on the scope axis the rewrite changes no number for any authorized row, and this is a contractual fix — the method can no longer over-read, and the grep gate can now see it. It is not a plugged data leak, and should not be described as one.** One residual, stated rather than glossed: `memory` carries no `CHECK` tying `scope` to `project_id` (`apps/server/src/db/schema/memory.ts:48`, and no such constraint in any migration), so adding `scope = 'project'` to the predicate is a no-op only for rows the current write path produces. If a malformed `scope='global'` row with a non-null `project_id` existed, the scoped count would be _more_ correct, not different-and-wrong.

**Code.** Concretely:

- `apps/server/src/db/repositories/memory-repository.ts:252-261` — `countByProject()` replaced by the scoped read (name and signature per design D1), with a doc comment that no longer promises a dimension the query lacks.
- `apps/server/src/mcp/project-tools.ts:55` — `memoryCount: z.number()` → `activeMemoryCount: z.number()` in `projectListOutput`.
- `apps/server/src/mcp/project-tools.ts:201-215` — the call site and the emitted field.
- `apps/server/src/mcp/server.ts:433-434` — `project.list`'s description currently reads "List existing projects and their memory counts." It must say the count is of active memories, so the model does not re-import the ambiguity the field name just shed. Well inside `DESCRIPTION_MAX_LENGTH` (`server.ts:124`).
- `apps/server/src/test/invariants.test.ts:726` — the inventory entry, deleted.

**Blast radius, re-verified on current `main`.** `grep -rn memoryCount` excluding `node_modules`, `.git` and `openspec/changes/archive` returns:

| Surface                                                                                                       | Hits                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/plugin/` (all four clients)                                                                             | **0**                                                                                                                                                                                                                |
| `docs/`                                                                                                       | **0**                                                                                                                                                                                                                |
| `README.md`                                                                                                   | **0**                                                                                                                                                                                                                |
| `openspec/specs/mcp-api/spec.md`                                                                              | 1 (`:885`, the contract line this change edits)                                                                                                                                                                      |
| `apps/server/src/mcp/project-tools.ts`                                                                        | 2 (`:55`, `:212` — this change)                                                                                                                                                                                      |
| `apps/server/src/db/repositories/agent-sessions-repository.ts` + `apps/server/src/services/agent-sessions.ts` | 2 (`:266`, `:604` — the unrelated per-session count, untouched)                                                                                                                                                      |
| `apps/server/src/scripts/seed-dev.ts`                                                                         | 6 (`:193`, `:206`, `:249`, `:349`, `:417`, `:425`) — a **local counter variable** in the seeder's summary log, not this field. Recorded because issue #310's grep did not mention it; it is unrelated and unchanged. |

No test asserts `memoryCount` today: the four `project.list` call sites in tests (`mcp-integration.test.ts:168`, `:427`, `:511`, `unresolvable-slug.test.ts:233`, `authorization.test.ts:348`) assert slugs and error-freedom only. The field is uncovered, which is part of why the defect survived — task 2 closes that.

**No plugin change.** Zero hits under `apps/plugin/`, so the shared-resource-single-copy rule and the four-client version lock-step are not in play. There is no typed client for `project.list`; agents read the JSON payload.

**Migration.** None. No schema change, no migration file, no derived-data invalidation — `memory_fts`, `memory_vec` and the three entity tables are untouched, and nothing needs regenerating. On a populated install (hundreds of memories, several projects) the first boot after upgrade does no extra work; the only observable difference is that `project.list` returns a differently-named, smaller number. Already-connected MCP clients keep their cached `tools/list` until they reconnect — harmless, since the description is prose and the payload key change is what a consumer sees either way. Rollback is a plain revert with no data consequence in either direction; the pre-change code reads the same rows.

Closes #310.
