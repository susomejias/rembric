# Measurements

Reproduced during apply, before any code changed. Every figure carries its denominator.

## Instrument

The shipped `extractEntities` (`EXTRACTOR_VERSION = v7-tracked-dotfiles-fair-budget`) over this
repo's own commit bodies — the shape a `memory.session_summary` carries (`summary` ≤ 10000).

Recipe (the script is deliberately not committed — task 2.4):

```js
// git log --format=%s%n%b<sep>, keep only commits whose BODY (beyond the subject line) is
// non-empty, then for each: extractEntities(subject, body).
// Compare kinds surviving `[...ents].sort((a,b) => kind then value).slice(0, 10)`
// against kinds surviving round-robin fair share over per-kind groups, kinds ascending.
```

**Deviation from the propose-time recipe, recorded rather than hidden.** The proposal says "this
repo's last 400 commit bodies (284 with a non-empty body)". The repo holds **340 commits total**,
so `HEAD~400..HEAD` does not resolve — "last 400" was already the whole history at propose time.
The run below is the full history. The `284 → 285` difference is the one commit that landed since
(`391c25d`).

Filtering on the body rather than the whole message is load-bearing: including subject-only
commits gives 340 documents and drags `p50` from 855 to 647 chars and `p99` from 8 to 6 entities.
The propose-time figures are reproduced only under the body filter, which is the correct one —
a subject-only commit is not a "commit body".

## Results

| figure                                                               | measured            | proposal          |
| -------------------------------------------------------------------- | ------------------- | ----------------- |
| documents                                                            | 285                 | 284               |
| body chars p50 / p90 / max                                           | 855 / 2548 / 8602   | 855 / 2534 / 8602 |
| entities per document p50 / p90 / p99 / max                          | 1 / 3 / 8 / 23      | 1 / 3 / 8 / 23    |
| documents where the bound binds (`entitiesTotal > 10`)               | **2 / 285** = 0.70% | 2 / 284 = 0.7%    |
| binding documents that lose an **entire kind** under `(kind, value)` | **2 / 2**           | 2 / 2             |
| binding documents that lose an entire kind under fair share          | **0 / 2**           | 0 / 2             |

The two figures the change rests on — `2/2` under the shipped order, `0/2` under fair share — are
reproduced exactly. D1 stands.

## The two binding documents, in full

| total | kinds present                      | lost under `(kind, value)` | lost under fair share | commit                                                                |
| ----- | ---------------------------------- | -------------------------- | --------------------- | --------------------------------------------------------------------- |
| 13    | `env_var`, `path`, `ticket`        | `ticket`                   | —                     | `feat(plugin): unified TUI installer for server + all clients (#122)` |
| 23    | `env_var`, `path`, `ticket`, `url` | `ticket`, `url`            | —                     | `feat(plugin): add opencode plugin (#56)`                             |

Both lose their issue reference. The 23-entity document keeps `env_var:HOME` plus nine paths and
drops `ticket:#56` and `url:https://opencode.ai` — it keeps the worst pivot available (`HOME` is
linked to nearly everything) and discards the two that address exactly one thing.

`ENTITIES_PROJECTION_CAP` stays 10: p99 is 8, so the bound sits above the 99th percentile of
production-shaped extraction. Raising it to 25 would cover the observed max of 23 while adding
nothing to 99.3% of rows.

## Why the resident dev corpus was rejected as the instrument

Recorded per task 2.3, so the rejection is evidence rather than an omission. Propose-time figures
(2026-07-29): **2055 memories**, content length p50 71 chars, at most **2** entity links per
memory, 31 of 32 distinct entities of kind `path`, and the bound binds on **0 rows**. A corpus
that cannot take a single binding decision cannot discriminate between two orderings of the
bound.

That corpus no longer exists — it was destroyed during the preceding change's smoke, because
`pnpm run dev:docker:up` runs `seed-dev --reset` on every boot. The figures above are the
propose-time observations and are **not** re-derivable today. They are retained because they
justify a rejection (the corpus is unusable as an instrument) rather than a claim about the
projection, and nothing in this change depends on them: the commit-body corpus is the instrument,
and it is re-derivable from `git log` by anyone at any time.
