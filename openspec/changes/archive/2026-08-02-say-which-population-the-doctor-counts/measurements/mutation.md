# Mutation runs (task 3)

Every run: `node scripts/mutate.mjs --file apps/server/src/mcp/server.ts --spec src/test/mcp-integration.test.ts`,
from the repo root, on 2026-08-02. Baseline reported `green` before each batch, so
none of the results below is a pre-existing failure. Both new tests live in
`apps/server/src/test/mcp-integration.test.ts`; `mutate.mjs` runs the whole spec
file (no `-t` filter) so a mutation caught by some OTHER test would also show.

The `find` strings are adapted to the wording actually landed (task 3's own
instruction): the landed text backticks the field and tool names, which the
task's illustrative `find` strings omit.

| Task | `--mutation` → `--with`                                                                  | Result                                                                                   |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 3.1  | `DB/embeddings/entities/consolidation health` → `DB/LLM/embeddings/consolidation health` | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.2  | `SERVER-WIDE (all projects + global)` → `scoped`                                         | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.3  | `` `memory.stats` carries the scoped equivalents `` → `counters may differ`              | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.4a | `/entities/consolidation health` → `/consolidation health`                               | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.4b | ``health, `sessions.active`, and review`` → `health, and review`                         | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.4c | `review queue depths` → `queue depths`                                                   | CAUGHT by 1 — `memory.doctor description discloses …`                                    |
| 3.5  | `` , `needsReviewTotal`, `pendingJudgmentsTotal` `` → `` (deletion)                      | CAUGHT by 1 — `memory.stats description names its queue-depth totals and the divergence` |

Full test names: `MCP protocol conformance > memory.doctor description discloses the
server-wide population and names memory.stats` and `MCP protocol conformance >
memory.stats description names its queue-depth totals and the divergence`.

3.4 needed three mutations rather than one: no single `find` removes `entities`,
`sessions` and `review` from the description while matching exactly once, and
`mutate.mjs` skips (and counts as uncovered) any `find` that does not match once.

Each mutation reddens exactly one test, which is the intended granularity — the
obligations are separate `expect` calls inside one test per tool, so removing one
disclosure cannot be masked by another still being satisfied.

`server.ts` was restored byte-identically after every batch (the script verifies
this and exits 2 otherwise); `git diff --stat` after the last run shows only the
two intended description lines.
</content>
</invoke>
