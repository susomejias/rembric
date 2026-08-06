# Containerised smoke for phase 5, against pre-existing seeded data

Phase 5 publishes the argument, so this is the first point at which a widening is
reachable by a client at all. Two things have to hold on a real deployment and
neither can be argued from the diff: **an upgrade must not change what an
installed deployment's ordinary search returns**, and **the widening must
actually cross a project boundary on real data** rather than on a fixture built
to make it.

`dev:docker:up` is **not** a valid instrument for either: it runs
`seed-dev --reset` on every boot and therefore has no pre-existing data. (Run
here by accident against a data copy, the shipped `latest` tag's dev target
refused the wipe — `[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`
— which is the guard working, not a valid arm.)

Phase 4's two smokes ran the server from source and each recorded that "task
6.3's containerised smoke is still owed". This one is containerised. Task 6.3
itself belongs to phase 6 and is not ticked here; what it will still owe after
this is the **rollback** half (task 6.4) on the same volume.

## Instrument

Two arms, one probe, one corpus. Each arm copies the **same pre-existing data
directory** — `data-dev.backup-20260805-0435`, taken before this branch existed —
into a fresh directory, runs the **runtime** image target on it as a bind mount
with no reset, and probes through the MCP SDK's
`StreamableHTTPClientTransport`, so every call passes the tool's zod schema.

- **before** — `rembric-p5:before`, built from `git archive ec3a8e7 | docker
build`, i.e. the phase-5 base. Exported rather than checked out, so the working
  tree was never mutated.
- **after** — `rembric-p5:after`, built from this branch's HEAD.

Both boots are genuine **upgrades** rather than fresh installs; each log reads:

```
[migrate] applying 0032_token_projects.sql
[bootstrap] rembric v0.25.2 ready
[bootstrap] listening on http://0.0.0.0:8787
```

Corpus, non-zero so no assertion below is vacuous:

```
memory=38  projects=2
demo    01KZ438C6NXV7RVF1D7STK1JT3  active 18  superseded 17
default 0e78131c32e07f0fca030c7e0c  archived 3
```

**The corpus's own shape forced one addition, and it is the finding that keeps
this smoke honest.** All three `default` rows are `archived`, so no ranked search
returns them from any scope — a widened page over them would have been an empty
set dressed as a passing assertion, which is exactly the vacuous proof this repo
keeps catching. One live row is therefore planted in `default` **through the real
`memory.save` path at the wire**, in both arms identically, before any widened
read. The 38 pre-existing rows are untouched.

## (a) The ordinary search is unchanged — byte-identical

Fourteen narrow reads per arm, ids captured **in page order** so a ranking move
would show as well as a membership one: six text queries plus the no-query
chronological listing, on each of the two projects.

```
JSON.stringify(before.narrow) === JSON.stringify(after.narrow)   →   true
```

Non-vacuity: **32 ids compared**, `demo` answering every query with 2–8 ordered
rows (`rembric`=2 `docker`=6 `search`=3 `token project`=3 `memory`=2
`basalt cistern`=8 listing=8), identical in both arms. `default`'s pages are
empty in both arms because its only rows are archived — stated rather than
counted as evidence, so the load-bearing arm is `demo`.

## (b) The widening crosses a project boundary, and says so

From `/mcp/demo` on a `*` token, `after` arm:

| call                               | count | projects returned  | `searchedProjects` | `widened` |
| ---------------------------------- | ----: | ------------------ | ------------------ | --------- |
| `entity:'#36'`                     |     1 | demo               | (absent)           | (absent)  |
| `entity:'#36', across_projects`    |     2 | demo **+ default** | `[demo, default]`  | `true`    |
| `query:'docker', across_projects`  |     1 | default            | `[demo, default]`  | `true`    |
| `query:'rembric', across_projects` |     2 | demo               | `[demo, default]`  | `true`    |

The **entity branch is the decisive row**: it carries no fusion, no rank window
and no relevance gate, so "rows from both projects" there is a claim about
admission rather than about ranking — narrow returns 1 row, widened returns 2,
from both projects, in the branch's chronological order, over a corpus with a
non-zero count on each side.

**One behaviour worth naming rather than glossing, measured on the ranked
branch:** a widened page can be _smaller_ than the narrow one and can _replace_
it. `query:'docker'` narrow returns demo's 6 rows; widened it returns 1 row, from
`default`, with **`gateShortened: true`**. The relative gate
(`RELATIVE_LEVEL_RATIO = 0.4`) is computed over the widened pool, so a strong
foreign leader cuts the home rows that were passing before. This is the design as
written — D8 forbids a home-project boost precisely so a better foreign answer can
win — and the published `gateShortened` flag is what tells the caller a gate cut
rows. It is recorded here because "I widened and got fewer of my own rows" is a
predictable operator question with a defensible answer, and because it is the
mirror image of the D14 risk (a mediocre leader passing a mediocre page).

## (c) A project-pinned token's widened search is its narrow search

`read:project:<demo>`, from `/mcp/demo`, query `rembric`:

```
narrow  ids: [01KZ438C9FMJ6NBG10B1VFB3A4, 01KZ438C99Q9WST0VHK6WVRX9B]
widened ids: [01KZ438C9FMJ6NBG10B1VFB3A4, 01KZ438C99Q9WST0VHK6WVRX9B]
searchedProjects: [demo]     widened: absent
```

Identical id-for-id and in the same order, one slug named, no `widened` claim for
asking. Non-vacuous: both pages carry two rows.

## (d) A widened read does not move where the next write lands

`memory.save` immediately after the widened read on the same `/mcp/demo`
connection:

```
01KZA5ZQTM7D2M50BWKZA40H2W  project_id=01KZ438C6NXV7RVF1D7STK1JT3 (demo)  scope=project
```

The planted control row, saved on a `/mcp/default` connection in the same run,
landed in `default` — so the assertion above is about the connection's home
project and not about a save path that ignores its scope.

## (e) Census: equal, and non-zero

Both arms, identically:

```
before  memory=38   demo active 18 / superseded 17   default archived 3
after   memory=40   demo active 19 / superseded 17   default active 1 / archived 3
```

`+2` in each arm is exactly the two rows the probe itself writes (the planted
`default` row and the post-widening `demo` save). No pre-existing row changed
project, status, or disappeared.

## The rollback direction, observed rather than argued

The `before` image — the same image an operator would roll back to — refuses the
new argument on **every** search a stale plugin would send:

```
MCP error -32602: Input validation error: Invalid arguments for tool memory.search:
  { "code": "unrecognized_keys", "keys": ["across_projects"], … }
```

Fail-closed, and legible. It is a hard error rather than a degraded search, which
is the direction the migration plan predicted and the sentence a release note
owes an operator. Task **6.4** still owns the rollback smoke proper (same volume,
census by count rather than by argument); this is the refusal shape only.

## What this does NOT establish

- **Not a rollback smoke.** Each arm ran on its own copy. Nothing here shows the
  `before` image reading a volume the `after` image had already written; that is
  6.4.
- **Nothing about latency.** No timing was taken, and none of these numbers may be
  quoted as one. Task 0.2's phase-4 re-run is a separate instrument.
- **Nothing about ranking quality.** Two projects, one of them holding a single
  live row, cannot say anything about how a widened page ranks at scale; that is
  `measurements/vec-partition-scale.md` and the eval's job.
- **Nothing about a set token.** This corpus's tokens are `*` and
  `project:<demo>`; the set arm is covered at the wire in
  `apps/server/src/test/widened-search-wire.test.ts`, not here.

## Reproduce

```sh
git archive ec3a8e7 | tar -x -C /tmp/p5-src-before
docker build -f apps/server/Dockerfile -t rembric-p5:before /tmp/p5-src-before
docker build -f apps/server/Dockerfile -t rembric-p5:after  .
# per arm: cp -r <pre-existing data dir> ./vol && chown -R 10001:10001 ./vol
docker run -d --name rembric-p5-<arm> -p 127.0.0.1:<port>:8787 -v "$PWD/vol:/data" \
  -e REMBRIC_ADMIN_TOKEN=… -e REMBRIC_UPDATE_CHECK=off rembric-p5:<arm>
# mint a `*` and a read:project:<demo> token against the volume, then probe
# through StreamableHTTPClientTransport and diff the two arms' narrow pages.
```
