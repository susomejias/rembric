# Measurement — can `SEARCH_DESCRIPTION` hold the restraint clause?

Task 5.4 / design D15. **Measured, not estimated**, and the measurement contradicts D15's own
arithmetic, so this file is the correction rather than a confirmation.

**Nothing here is wired in yet, deliberately.** The `across_projects` argument does not exist until
phase 5. A description that offers an argument the schema refuses is the exact defect
`mcp-api/spec.md:2576` governs — "a tool's description and its response MUST agree, and neither may
promise an unreachable state" — and today it would make the model send an argument that comes back
`-32602 unrecognized_keys`. The clause lands with the argument, in one commit, or not at all.

## The budget, measured from the constant

| quantity                                                                                          |   chars |
| ------------------------------------------------------------------------------------------------- | ------: |
| `SEARCH_DESCRIPTION.length` (`mcp/server.ts`)                                                     |   1 854 |
| `DESCRIPTION_MAX_LENGTH`                                                                          |   1 900 |
| free headroom                                                                                     |      46 |
| reclaim 1 — `" Every connection sees exactly one project's memories."` (becomes FALSE regardless) |      54 |
| reclaim 2 — the entity-kind list `" (path, git SHA, …, UUID)"`                                    |      94 |
| **total available for a new clause, both reclaims taken**                                         | **194** |

Both clause lengths and their presence were read out of the file, not counted by hand.

## The finding: D15's estimate was optimistic

D15 records "a minimal conforming replacement — naming the argument, the restraint condition and the
marker — measures ≈170 characters in draft, so **the second reclaim is probably required**". Measured
against real candidates:

| candidate                                                   | chars | reclaim 1 only | reclaims 1 + 2     |
| ----------------------------------------------------------- | ----: | -------------- | ------------------ |
| A — argument + restraint + reason + marker, unhurried prose |   299 | over by 199    | over by 111        |
| B — same content, tightened                                 |   251 | over by 151    | over by 57         |
| C — terse                                                   |   184 | over by 84     | fits, 10 spare     |
| **D — recommended**                                         |   182 | over by 82     | **fits, 12 spare** |
| F — strongest restraint wording                             |   192 | over by 92     | fits, **2 spare**  |

**The second reclaim is not "probably" required, it is required, and it is barely enough.** No wording
that states all four things fits on reclaim 1 alone, and the wording that states them most forcefully
(F) leaves two characters. Recorded because D15 left this as a maybe and a maybe would have been
discovered at the end of phase 5, with the wording already agreed.

## The owner's stated intent, and what it costs

Recorded verbatim because it is what the wording has to carry: the option exists "sólo para casos
aislados o cuando el usuario lo solicite" — isolated cases **or** an explicit user request — "ya que
puede contaminar con memorias de otros proyectos", because it can contaminate the page with other
projects' memories.

That is **two** trigger conditions, not one, plus the reason. Measured, it does not fit in 194:

| candidate                                                | chars | reclaims 1 + 2    |
| -------------------------------------------------------- | ----: | ----------------- |
| G — both triggers, unhurried                             |   212 | over by 18        |
| H — both triggers, tightened                             |   204 | over by 10        |
| I — both triggers, compressed to "or nothing found here" |   193 | fits, **1 spare** |

**A third reclaim is therefore required, and this is the second correction to D15's arithmetic.**
`" Each result carries \`entities[]\`, so you can pivot to a related identifier."`(76 chars) is the
cheapest one left: it describes a response field that the output schema already publishes, and unlike
the entity-kind list it has no per-argument`describe()` to lose. With reclaims 1 + 2 + 3 the budget is
**270**, and the wording the owner asked for fits with 30 spare:

```
 `across_projects:true` also reads the other projects this token may reach. Never a default: only on an explicit ask, or when this project came back empty. It dilutes the page with foreign memories. `searchedProjects[]` names what was read.
```

240 chars. Both triggers, the reason, the marker, and a margin that does not break CI on the next edit.
**This is the recommended wording**; D below is what fits without the third reclaim and is kept only to
show what the third reclaim buys.

## Fallback wording (D) — two reclaims only, one trigger

```
 `across_projects:true` also reads the token's other projects. Explicit cross-project asks only — it dilutes the page with foreign memories. `searchedProjects[]` names what was read.
```

182 chars, 12 spare. It carries the argument, one restraint condition, the reason, and the marker —
but it drops the "or this project came back empty" trigger the owner named, so it understates when the
option is legitimate. Kept as the fallback if the third reclaim is refused in review.

The stronger alternative, if the 2-character margin is judged acceptable:

```
 `across_projects:true` also reads this token's other projects. Most searches must NOT: it dilutes the page with foreign memories. Explicit asks only. `searchedProjects[]` names what was read.
```

192 chars, 2 spare. Says "most searches must not" outright. **Not recommended**: `mcp-api/spec.md:2183`
keeps the margin below the verified client ceiling so the guard fires on approach, and a two-character
margin means the next clause anyone adds breaks CI rather than warning.

**Raising `DESCRIPTION_MAX_LENGTH` is not an option here** (task 5.5): it is permitted only with a
re-verified client ceiling and the retained margin recorded, and the current 148-character margin below
Claude Code's verified 2 048 exists precisely so this guard fires early.

## The cost of reclaim 2, stated rather than glossed

The entity-kind list moves from the top-level description into the `entity` property's own uncapped
`describe()`. `mcp-api/spec.md:462` records that some clients do not surface per-argument descriptions,
so this is a **partial loss, not a free move**: on those clients the model stops being told which kinds
of literal belong in `entity`. Named here so it is a decision in review rather than a side effect.

## Open: the argument's name

The request that prompted this file said `all_projects`. **D11 rejected that name** and task 7.2 records
the rejection: on a set token it promises every project and delivers the member set, and a published
input name that overclaims is the class `mcp-api/spec.md:2576` governs. The drafts above therefore use
`across_projects`. Swapping them is a one-line change and costs one character; overturning D11 is not,
and is not done here.

## Reproduce

```sh
cd apps/server && node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const m = /const SEARCH_DESCRIPTION =\n  '([\s\S]*?)';\n/.exec(readFileSync('src/mcp/server.ts','utf8'));
  console.log(m[1].replace(/\\\\'/g, \"'\").length);
"
```

Per task 5.6 this figure MUST be re-measured from a live `tools/list` response before phase 5 closes —
the constant is what the file holds, not necessarily what the wire carries.

## Re-verification: is there a cheaper 94 characters than the entity-kind list?

The plan above takes reclaim 2 (the entity-kind list) as necessary, and reclaim 2 is the only one of
the three with a named cost — `mcp-api/spec.md:462` records that some clients do not surface
per-argument `describe()`, so moving the list there loses it on those clients. That makes "find 94
characters of pure verbosity instead" worth testing before accepting the loss. **Tested, and the
answer is no.**

Measured against the constant, sentence by sentence, counting only rewrites that preserve every fact:

| rewrite                                                                       |  saves |
| ----------------------------------------------------------------------------- | -----: |
| `offset` sentence: drop "also works but", keep "ranked over a bounded window" |     15 |
| trigger list: four recall examples instead of five, both languages kept       |     13 |
| **total genuinely lossless**                                                  | **28** |

**A first pass claimed 93 and was wrong.** It counted deleting
`"Answers \"what do I know about this file/error/host\"; …"` (53) as verbosity. It is not: that
sentence is the use-case cue that tells the model _when_ to reach for `entity` at all, and unlike the
entity-kind list it has no `describe()` to fall back to. Cutting it trades a better-covered loss for a
worse-covered one. Recorded because the arithmetic looked like a free win and was not.

So the budget is a two-way choice, both arms measured (free 46 + reclaim 1's 53 + lossless 28 +
reclaim 3's 75 = 202 before any entity-list decision):

| arm                                    | budget | clause that fits              | spare | what it costs                                          |
| -------------------------------------- | -----: | ----------------------------- | ----: | ------------------------------------------------------ |
| **A — take reclaim 2**                 |    296 | the 240-char, **two-trigger** |    56 | entity-kind list survives only in `describe()`         |
| B — keep the entity-kind list in place |    202 | the 182-char, **one-trigger** |    20 | drops "or this project came back empty" from the steer |

**Recommended: A.** The owner named two trigger conditions, and B silently drops one of them — a
description that understates when the option is legitimate is the same class of defect as one that
overstates it, and this one would push the model toward never widening rather than toward widening
carelessly. A's residual cost is bounded and partial (the list survives wherever `describe()` is
surfaced); B's cost falls on the steer itself, which is the whole point of the requirement. A also
leaves 56 characters of margin against 20, and `mcp-api/spec.md:2183` keeps a margin precisely so the
guard fires on approach rather than on arrival.

Still not wired in: the clause lands in phase 5 with the argument, in one commit.

## What actually shipped, and one deliberate departure from arm A

Measured from a live `tools/list` after phase 5: **1856 characters, 44 of headroom.**

Arm A's own arithmetic was off by two — reclaim 1 is 54 characters, not 53, and reclaim 3 is 76, not
75 — so the arm left 58 spare rather than 56. One reclaim also cost less than this document priced it:
re-homing the entity-kind list into `entity`'s own `describe()` turned out to be a **deletion, not a
transfer**, because that `describe()` already listed the same kinds. The partial loss
`mcp-api/spec.md:458` warns about is therefore not incurred at all.

**The second trigger shipped broader than the wording recommended above, and 14 of those spare
characters paid for it.** The recommended clause said the option is legitimate "when this project came
back empty". The delta spec says "genuinely exploring broadly and the answer is not expected in the
current project", and the owner's own words were "sólo para casos aislados o cuando el usuario lo
solicite" — isolated cases **or** an explicit request. "Came back empty" is narrower than either: it
admits only the case where the narrow search already failed, and a description that understates when an
option is legitimate steers the model away from using it at all, which is the mirror of the overuse this
requirement exists to prevent. The shipped clause reads "…or when the answer is not expected in this
project", which is the delta spec's condition in the budget's register.

Cost accounted: 1842 + 14 = **1856**, headroom 44, still the largest margin any candidate in this
document leaves. The published length is pinned by test at the MCP boundary, so a later reword cannot
drift the budget silently.
