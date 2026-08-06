# Upgrade and rollback on ONE volume, against pre-existing seeded data

Tasks 6.3 and 6.4. Phase 5's containerised smoke
(`containerised-smoke-phase-5.md`) ran each arm on **its own copy** of the data
directory, so it never tested one image reading what the other wrote — it says
so itself. This one uses a single volume and three boots in sequence, so the
rollback reads a database the new image has already written to.

`dev:docker:up` is not a valid instrument for either half: it runs
`seed-dev --reset` on every boot and therefore has no pre-existing data.

## Instrument

One volume, `vol6`, copied once from `data-dev.backup-20260805-0435` — a data
directory taken before this branch existed — and never reset. Three boots on it,
in order:

| boot | image            | built from                                    | role                               |
| ---- | ---------------- | --------------------------------------------- | ---------------------------------- |
| A    | `rembric-p6:old` | `17c9706`, this branch's merge-base on `main` | the deployment as it stands        |
| B    | `rembric-p6:new` | `6f998b8`, this branch's HEAD                 | the upgrade, same volume, no reset |
| C    | `rembric-p6:old` | the same image as A                           | the rollback, reading what B wrote |

`17c9706` is the image an operator rolls back **to**: it is `main`, so it has
neither `across_projects` nor the `Scope` collapse. Every probe call goes through
the MCP SDK's `StreamableHTTPClientTransport`, so each one passes the tool's zod
schema rather than bypassing it.

**Only the very first boot migrated anything.** A preparatory boot of the OLD
image applied `0032_token_projects.sql` (the volume predates it), and after that
no boot applied a migration — neither the upgrade nor the rollback:

```
p6-migrate (old)  [migrate] applying 0032_token_projects.sql … committing
p6-a (old)        [bootstrap] counts: memory=38 projects=2 sessions=5 tokens=5
p6-b (new)        [bootstrap] counts: memory=39 projects=2 sessions=5 tokens=5
p6-c (old)        [bootstrap] counts: memory=40 projects=2 sessions=5 tokens=5
```

That is the design's "there is no migration" claim as an observation rather than
as an argument, and boot C's count is the rollback reading all 40 rows including
the one the new image wrote.

## The corpus, and the one addition it forced

```
memory=38  memory_vec=38  projects=2   integrity_check=ok   project_id IS NULL: 0
demo     01KZ438C6NXV7RVF1D7STK1JT3   active 18   superseded 17
default  0e78131c32e07f0fca030c7e0c   archived 3
```

All three `default` rows are `archived`, so no ranked search returns them from
any scope and a widened page over them would have been an empty set dressed as a
passing assertion — the same trap phase 5 recorded. One live row is therefore
planted in `default` **through the real `memory.save` path at the wire on the OLD
binary, before any read**, so from the new image's point of view it is
pre-existing data rather than something the measurement made for itself. It
carries the identifier `#36`, which a `demo` row also carries, so the entity
branch has a non-zero count on each side.

## (a) The ordinary search is unchanged across the upgrade

Sixteen reads per boot with ids captured **in page order**, so a ranking move
shows as well as a membership one: six text queries, the no-query chronological
listing and the entity lookup, on each of the two projects.

```
boot A (old) narrow  vs  boot B (new) narrow   →   16 keys, 41 ids, 0 differing
```

Per-key counts, identical in both: `demo` `rembric`=2 `docker`=6 `search`=3
`token project`=3 `memory`=2 `basalt cistern`=8 listing=8 entity=1; `default`
1 on every read.

**The comparison is not vacuous, and the control is a change the same sweep does
catch.** Re-run inside boot B after the probe's own save, the identical sweep
differs — `demo:listing` gains `01KZA7KV4VYKF1HNPP9RC3XKH9` at the head:

```
B narrow      demo:listing  [01KZ438CA1JA…, 01KZ438CA0AB…, … 8 rows]
B narrowPost  demo:listing  [01KZA7KV4VYK…, 01KZ438CA1JA…, … 8 rows]
```

So an instrument that reads "0 differing" over the upgrade is one that would have
reported a difference had there been one.

## (b) The widening crosses a project boundary, and says so

From `/mcp/demo` on a `*` token, boot B:

| call                               | count | projects returned  | `searchedProjects` | `widened` | `gateShortened` |
| ---------------------------------- | ----: | ------------------ | ------------------ | --------- | --------------- |
| `entity:'#36'`                     |     1 | demo               | (absent)           | (absent)  | (absent)        |
| `entity:'#36', across_projects`    |     2 | demo **+ default** | `[demo, default]`  | `true`    | (absent)        |
| `query:'docker'`                   |     6 | demo               | (absent)           | (absent)  | `true`          |
| `query:'docker', across_projects`  |     1 | **default**        | `[demo, default]`  | `true`    | `true`          |
| `query:'rembric'`                  |     2 | demo               | (absent)           | (absent)  | `true`          |
| `query:'rembric', across_projects` |     1 | **default**        | `[demo, default]`  | `true`    | `true`          |

The **entity branch is the decisive row**: no fusion, no rank window, no
relevance gate, so "rows from both projects" there is a claim about admission
rather than about ranking — 1 row narrow, 2 widened, over a corpus with a
non-zero count on each side.

**A widened page can be smaller than the narrow one and can replace its rows
entirely.** `query:'docker'` goes from 6 home rows to 1 foreign row;
`query:'rembric'` from 2 home rows to 1 foreign row. Both carry
`gateShortened: true`. The cause is that `RELATIVE_LEVEL_RATIO = 0.4` is computed
over the **widened** pool, so one strong foreign leader cuts home rows that were
passing. This is the design as written — D8 forbids a home-project boost
precisely so a better foreign answer can win — and `gateShortened` is what tells
the caller a gate cut rows. Phase 5 saw it on one query; on this volume it
reproduces on two, so it is the ordinary case for a small foreign project holding
one highly on-topic row, not a curiosity. D14 names only the mirror case (a
mediocre leader passing a mediocre page), so the release note and `docs/agents.md`
carry this one.

## (c) A project-pinned token's widened search is its narrow search

`read:project:<demo>`, from `/mcp/demo`, `query:'rembric'`:

```
narrow  ids: [01KZ438C9FMJ6NBG10B1VFB3A4, 01KZ438C99Q9WST0VHK6WVRX9B]
widened ids: [01KZ438C9FMJ6NBG10B1VFB3A4, 01KZ438C99Q9WST0VHK6WVRX9B]
searchedProjects: [demo]     widened: absent
```

Identical id-for-id and in the same order, one slug named, no `widened` claim for
asking. Non-vacuous: both pages carry two rows, and the same connection's widened
call over the same corpus is what the `*` token answers with a foreign row.

## (d) A widened read does not move where the next write lands

`memory.save` on the same `/mcp/demo` connection immediately after the widened
reads landed `01KZA7KV4VYKF1HNPP9RC3XKH9`, and the census puts it in `demo`:
`demo` active 18 → 19, `default` unchanged at active 1 / archived 3.

## (e) Census — equal, non-zero, and moving only by the probe's own writes

| point              | memory | memory_vec | demo                      | default               | project_id IS NULL | integrity |
| ------------------ | -----: | ---------: | ------------------------- | --------------------- | -----------------: | --------- |
| pristine           |     38 |         38 | active 18 / superseded 17 | archived 3            |                  0 | ok        |
| after 0032         |     38 |         38 | active 18 / superseded 17 | archived 3            |                  0 | ok        |
| after A (old)      |     39 |         39 | active 18 / superseded 17 | active 1 / archived 3 |                  0 | ok        |
| after B (new)      |     40 |         40 | active 19 / superseded 17 | active 1 / archived 3 |                  0 | ok        |
| after C (rollback) |     40 |         40 | active 19 / superseded 17 | active 1 / archived 3 |                  0 | ok        |

`+1` at A is the planted `default` row, `+1` at B is the post-widening save, and
the rollback moves nothing. No pre-existing row changed project, status or
disappeared; every row is `scope='project'` throughout.

## Task 6.4 — the rollback, measured on the same volume

**The argument is refused, and the refusal is the whole asymmetry.** On the OLD
image, at the wire, on the connection whose narrow search works:

```
REFUSED  {"query":"rembric","across_projects":true}
  MCP error -32602: Input validation error: Invalid arguments for tool memory.search: [
    { "code": "unrecognized_keys", "keys": ["across_projects"], "path": [],
      "message": "Unrecognized key(s) in object: 'across_projects'" } ]

ACCEPTED {"query":"rembric"}  -> count=2       ← the control, same connection
```

`across_projects` is an **input the old binary refuses**, not data it misreads.
Nothing the new image wrote is unreadable by the old one, because none of it is
new: the rows the new image added are ordinary `memory` rows, and boot C reads all
40 of them.

Measured from each image's own live `tools/list`, which is what a client actually
sees:

| image | `memory.search` input properties                           | description length | headroom |
| ----- | ---------------------------------------------------------- | -----------------: | -------: |
| old   | no `across_projects`                                       |               1854 |       46 |
| new   | `across_projects` between `status` and `include_relations` |               1856 |       44 |

`all_projects` — the superseded name (D11) — is refused `-32602
unrecognized_keys` on **both** images, so a client pinned to it fails the same way
before and after.

**Every narrow read is unchanged by the rollback**, over a corpus identical to the
one boot B left:

```
boot B narrowPost  vs  boot C narrow   →   16 keys, 41 ids, 0 differing
```

Compared against `narrowPost` rather than `narrow` deliberately: boot B's own save
lands between the two sweeps, so comparing C against B's _first_ sweep would have
reported the probe's write as a rollback difference.

## What this does NOT establish

- **Nothing about latency.** No timing was taken and none of these numbers may be
  quoted as one. `measurements/narrow-path-regression.md` §7 is that instrument.
- **Nothing about a set token.** This volume's tokens are `*` and
  `read:project:<demo>`. The `projects` / `read:projects` arm is covered at the
  wire in `apps/server/src/test/widened-search-wire.test.ts`.
- **Nothing about ranking quality.** Two projects, one holding a single live row,
  cannot say how a widened page ranks at scale; that is
  `measurements/vec-partition-scale.md` and the eval's job.
- **Nothing about a write made while rolled back.** Boot C only read. The
  stranded-row hazard `retire-the-global-scope` 16.14 records is a different
  mechanism (a scope the newer image cannot address) and is untouched here — this
  change adds no scope and no column.

## Reproduce

```sh
git archive 17c9706 | tar -x -C /tmp/src-old
docker build -f apps/server/Dockerfile -t rembric-p6:old /tmp/src-old
docker build -f apps/server/Dockerfile -t rembric-p6:new .
cp -r <pre-existing data dir> ./vol6 && rm -f vol6/data.db-shm vol6/data.db-wal
# boot old (migrates), stop, mint a `*` and a read:project:<demo> token into
# vol6/data.db, then boot old → new → old on that same volume, probing through
# StreamableHTTPClientTransport and censusing the file between boots.
```
