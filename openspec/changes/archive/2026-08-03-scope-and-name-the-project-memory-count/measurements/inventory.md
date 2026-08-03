# Invariant inventory and the `admin*` gate (task 4)

## 4.2 — direction one: a listed read that is gone

With the source fix in place, `'memory-repository.ts::countByProject'` was temporarily
re-added to `UNSCOPED_UNPREFIXED_READS` and the test re-run:

```
$ pnpm vitest run src/test/invariants.test.ts -t 'the unscoped, un-keyed, unprefixed reads are exactly the inventory'

-   "memory-repository.ts::countByProject",
    "memory-repository.ts::countPurgeableDisconnectedArchived",
 ❯ src/test/invariants.test.ts:801:26
    801|     expect(found.sort()).toEqual([...UNSCOPED_UNPREFIXED_READS].sort()…

 Test Files  1 failed (1)
      Tests  1 failed | 72 skipped (73)
```

FAILS as required. Restored.

## 4.3 — direction two: an unlisted unscoped read

With the inventory entry deleted, `countActiveInScope` was temporarily reverted to the
unparameterised `countByProject` and the same test re-run:

```
+   "memory-repository.ts::countByProject",
    "memory-repository.ts::countPurgeableDisconnectedArchived",
 ❯ src/test/invariants.test.ts:800:26
    800|     expect(found.sort()).toEqual([...UNSCOPED_UNPREFIXED_READS].sort()…

 Test Files  1 failed (1)
      Tests  1 failed | 72 skipped (73)
```

FAILS as required. Restored; `git diff --stat` matched the pre-experiment diffstat.

Both directions gate. The inventory is not decorative here.

## 4.4 — the method is undetected because it is scoped, not because of its spelling

`unscopedUnprefixedReads` (`invariants.test.ts:760-779`) was re-run in isolation over
the landed `memory-repository.ts`, once with both skip branches and once with only the
scope branch at `:774`:

```
both branches   -> detected: ["countRowsByStatus","countPurgeableDisconnectedArchived","findPurgeableDisconnectedArchivedIds"]
  countActiveInScope detected? false
scope branch ONLY -> detected: ["idsWithTag","idsWithTopicKey","findScopeTupleById","findSuccessorId","countRowsByStatus",
                                "countConfirmations","existingIds","findReplaces","reviewTimestampsByIds",
                                "confirmationCountsByIds","rankingMetadataByIds","countPurgeableDisconnectedArchived",
                                "findPurgeableDisconnectedArchivedIds"]
  countActiveInScope detected? false
```

`countActiveInScope` stays undetected with the key-bounded branch at `:775` disabled.
The parameter text is `scope: MemoryScope, projectId: string | null`, which matches
`/\b(scope|projectId|partitionKey)\b/` at `:774` — the branch that runs first and
`continue`s. The rejected fallback shape (design D1 Alternative A) would have relied on
`:775` instead; this one does not.

## 4.5 — which way the `admin*` confinement gate falls

```
$ pnpm vitest run src/test/invariants.test.ts -t 'admin-method confinement invariant'
 Test Files  1 passed (1)
      Tests  2 passed | 71 skipped (73)
```

The gate (`invariants.test.ts:623-679`, pattern `/\.(admin[A-Z]\w*)\(/g`) **correctly
does not see** `countActiveInScope`, and that is the required answer rather than a
finding: the method is not `admin`-prefixed, because it filters to exactly one scope
(design D3). `ADMIN_CALL_SITES` (`:625-645`) gained **no** entry for
`mcp/project-tools.ts` — verified: `grep -n 'mcp/project-tools' invariants.test.ts`
returns 0 hits, and `grep -c 'adminCountActive\|\.admin[A-Z]' src/mcp/project-tools.ts`
returns 0. Nothing was renamed against D3.

## 4.6 — `data-access/spec.md:47` needs no change

`awk 'NR>=721 && NR<=737' invariants.test.ts | grep '//'` returns nothing after the
deletion: no inventory line carries a violation marker any more, so `:47`'s conditional
("SHALL mark any entry that is also a violation") is satisfied vacuously. No requirement
text under `openspec/specs/` was edited by the apply phase — `git diff --name-only --
openspec/specs/` is empty.
