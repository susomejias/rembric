# The write path cannot hold a widened scope — measured, not argued

Task 4.2 owes a hand `tsc` widen/restore loop rather than a `mutate.mjs` run:
`scripts/mutate.mjs` drives vitest, and vitest ignores `@ts-expect-error`, so a
type barrier is invisible to it. Everything below was executed in this worktree
with `npx tsc --noEmit` from `apps/server/`.

The directives under test live in
`apps/server/src/services/search-scope.test.ts::'is refused by every write and
non-search read'`: six calls, never invoked, each carrying `@ts-expect-error`
above a widened `SearchScope` handed to a write or a single-row read
(`save`, `saveWithTopicKey`, `archive`, `confirm`, `get`, `getMany`).

`TS2578 Unused '@ts-expect-error' directive` is the signal: it fires when the
call it guards STOPS being an error, so it is what turns "a write path started
accepting a widened scope" into a red build.

## Arm 1 — as shipped

```
$ npx tsc --noEmit
(no output, exit 0)
```

Every directive is USED: all six calls are type errors, so the barrier holds.

## Arm 2 — widen ONE write path's parameter

`MemoryService.save(input, scope: Scope)` → `scope: SearchScope`, nothing else
touched:

```
$ npx tsc --noEmit
src/services/memory.ts(200,56): error TS2345: Argument of type 'SearchScope' is not assignable to parameter of type 'Scope'.
  Property 'projectId' is missing in type '{ kind: "authorized-projects"; projectIds: readonly string[]; homeProjectId: string; }' but required in type 'Scope'.
src/services/search-scope.test.ts(65,7): error TS2578: Unused '@ts-expect-error' directive.
```

`search-scope.test.ts:65` is the `save` directive, and it is the ONLY one that
went unused — the other five write paths still refuse. The build reds twice
over: at the widened signature itself (`save`'s body immediately passes the
scope to a repository read that takes a `Scope`, so the barrier is layered
rather than resting on one declaration) and at the now-unused directive.

Restored, and `npx tsc --noEmit` returned to clean output before the next arm.

## Arm 3 — the shape design D3 and task 7.8 reject

Issue #304 proposed folding the widening into `Scope` itself. Applying that
shape — `Scope = { kind: 'project'; … } | { kind: 'authorized-projects'; … }`,
with `SearchScope` left as it is:

```
$ npx tsc --noEmit | grep TS2578
src/services/search-scope.test.ts(65,7): error TS2578: Unused '@ts-expect-error' directive.
src/services/search-scope.test.ts(67,7): error TS2578: Unused '@ts-expect-error' directive.
src/services/search-scope.test.ts(69,7): error TS2578: Unused '@ts-expect-error' directive.
src/services/search-scope.test.ts(71,7): error TS2578: Unused '@ts-expect-error' directive.
src/services/search-scope.test.ts(73,7): error TS2578: Unused '@ts-expect-error' directive.
src/services/search-scope.test.ts(75,7): error TS2578: Unused '@ts-expect-error' directive.
```

**All six.** Under the one-union shape every write path and both single-row
reads accept a widened scope, exactly as 7.8 records ("#304's single union makes
every write path _able_ to hold a widened value, so only discipline stops it").
The same run printed 140 lines in total; the other 134 are the ordinary
consequence of `scope.projectId` no longer being present on every arm, and are
not the finding.

Restored, `npx tsc --noEmit` clean, `git status` shows `services/scope.ts`
unmodified.

## What this does NOT establish

- It says nothing about runtime. A `SearchScope` cast through `any` or arriving
  as untyped JSON reaches a write path unimpeded; the compiler is the first
  line, and task 4.5's grep gate is the second.
- It does not prove the widening WORKS. Arm 1 only shows the widened value is
  unexpressible on a write; the search path honouring more than the home
  project is tasks 4.6–4.9.
- D17's first correction is confirmed rather than re-tested here: the barrier
  lives at the option-bag level, not in `scopeWhere`'s parameter. Arm 2 widened
  a service method's parameter — one level above the builders — and that is
  where the directive moved.
