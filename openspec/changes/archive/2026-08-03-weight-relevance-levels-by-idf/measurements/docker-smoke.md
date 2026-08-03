# Task 10.7 — real Docker smoke against pre-existing seeded data

Covers §8.4, which the earlier apply session left NOT RUN.

## Setup (10.7.1)

- `tar -czf data-dev-backup.tgz data-dev` before anything, and `chown -R 10001:10001 data-dev`.
- The pre-existing `data-dev` corpus already carried migration `0030` from an earlier
  run of this change, so **it was rolled back first** to make the upgrade real:
  `DROP TABLE memory_fts_vocab` + `DELETE FROM _migrations WHERE filename = '0030…'`,
  leaving a 35-memory database at the pre-`0030` schema with its real seeded content.
- Brought up with `docker compose -f docker-compose.yml -f docker-compose.dev.yml -f
<override> up --build -d`, where the override replaces the dev CMD (dropping
  `tsx src/scripts/seed-dev.ts --reset`) and sets `REMBRIC_ALLOW_DESTRUCTIVE_SEED: '0'`.
  The override file was deleted after teardown; it is not part of the change.
- Mounts verified: `/root/rembric/data-dev -> /data` and
  `/root/rembric/apps/server/src -> /app/apps/server/src` — this worktree.
- **Seed lines in the boot log: 0** (`docker logs rembric-dev | grep -ic seed`).
- `counts: memory=35 projects=2 sessions=5 tokens=9 prompts=0` — the pre-existing corpus.

## 10.7.2

| #   | check                                                                                                           | result                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `0030` applies to the pre-existing database and the vocabulary read returns non-zero frequencies for real terms | ledger row present after boot; `memory_fts_vocab` top terms `the=10 demo=8 for=8 judged=8 on=6 runbook=6 auth=5 in=5`. No backfill step ran.                                                                                                                        |
| b   | the tokenising table is derived at startup and the boot log names the tokenizer it inherited                    | `[info] query tokenizer inherited from memory_fts: fts5 defaults`, and the in-container probe reports `inherited fts5 arguments: []` — agreeing, because the shipped declaration carries no `tokenize=`.                                                            |
| c   | `memory.search` returns sane, non-empty results, ids captured                                                   | `memory.search{query:'runbook'}` → 1 row, id `01JYWAWW2ZRRRSE7RBJXAW1AXK`; `{query:'demo'}` → 5 rows.                                                                                                                                                               |
| d   | `abstained` / `abstainReason` present on every MCP response                                                     | `abstained: false` on every response. **`abstainReason` is present only when abstaining**, and with `ABSTENTION_FLOOR = null` no response can abstain — so the key was absent on all four probes. Recorded as measured rather than as the task's wording predicted. |
| e   | `memory.context` returns both channels populated                                                                | `recentMemories=10 relevantMemories=1 pendingJudgments=0`; keys `scope recentSessions recentPrompts recentMemories relevantMemories pendingJudgments pendingJudgmentsTotal needsReview needsReviewTotal clamped`.                                                   |

## 10.7.3 — the production defect, on real data

Through the real MCP tool (HTTP JSON-RPC on `/mcp/demo`), 20 Cyrillic memories saved
into the pre-existing corpus, one of which also carries the rare word:

| query                                                                                           | rows returned |
| ----------------------------------------------------------------------------------------------- | ------------- |
| `майский ёлка`, limit 20                                                                        | **10 of 20**  |
| `runbook zzqqxxnothing`, limit 20                                                               | 1             |
| `how does the atlas graphql schema versioning strategy work` (no answer in the corpus), limit 8 | 2             |
| `demo` (broad), limit 5                                                                         | 5             |

The same construction pre-amendment returns **20 of 20** (`mcp-script-arms-before.txt`,
in-process with a hash embedder). The Docker arm is not a controlled pair with it — a
real embedder decides the fallback here — so the controlled before/after remains the
committed artifact, and this is the real-data confirmation that the "everything comes
back" outcome is gone.

The df resolution itself, measured with the shipped code in the shipped container
against `/data/data.db` (`docker exec … tsx`, `documentCount = 55` after the saves):

```
query "майский ёлка" -> майский=20(w=1.0049) ёлка=1(w=3.6199)
  app indexTerms would have keyed on: маискии елка | max weight = 4.7185
query "runbook demo"  -> demo=8(w=1.8853) runbook=6(w=2.1535)
  app indexTerms would have keyed on: runbook demo | max weight = 4.7185
query "zzqqxxnothing" -> zzqqxxnothing=ABSENT(w=4.7185)
  app indexTerms would have keyed on: zzqqxxnothing | max weight = 4.7185
```

`майский` resolves to the corpus's real document frequency and a weight of 1.0049
where the application's own key (`маискии`) is absent from the index and would have
taken the 4.7185 maximum. The Latin control resolves identically under both keyings,
and a genuinely absent term is still reported ABSENT and still takes the maximum — so
abstention is preserved rather than disarmed.

## 10.7.4 — durability and logical content

In-container, on the real database, 2 000 tokenisations with no other writes:

```
durable size before: {"db":10027008,"wal":4148872}
after 2000 tokenisations: {"db":10027008,"wal":4148872}
durable growth from tokenisation: 0 bytes
```

**The pre-amendment comparison arm was not run in Docker** (the container runs one
tree at a time, and rebuilding the image on the pre-amendment tree would have
invalidated the same-corpus comparison). It is not needed for this claim: the
measurement is an absolute zero, and a baseline can only be ≥ 0.

Logical content against the tar backup, not a byte compare of `data.db`:

|                                                                    | backup                                                             | after the smoke                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `memory`                                                           | 35                                                                 | 55 (the 20 rows the smoke saved)                                 |
| pre-existing rows missing                                          | —                                                                  | **0**                                                            |
| pre-existing rows whose content / status / attribution changed     | —                                                                  | **0**                                                            |
| digest over the 35 pre-existing rows                               | `44d63105d64e00ee63347ed92659e948f6cc8687df06e6d7ccb71341ae8da9ba` | identical                                                        |
| `confirmations` digest                                             | `e3b0c442…52b855` (empty)                                          | identical                                                        |
| `memory_replaces` / `sessions` / `tokens` / `projects` / `prompts` | 17 / 5 / 9 / 2 / 0                                                 | identical                                                        |
| `memory_relations`                                                 | 21                                                                 | 109 — the save-time candidate detector on 20 near-identical rows |

Teardown: `docker compose … down --remove-orphans`, then `data-dev` restored from the
tar (35 rows, digest matches the pre-boot digest, `0030` present as it was found).
