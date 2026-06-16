## Context

Every Rembric MCP tool is registered via `server.registerTool(name, { description, inputSchema }, handler)` in `apps/server/src/mcp/server.ts`. None declares `annotations`. The MCP SDK (`@modelcontextprotocol/sdk@1.29.0`) accepts an `annotations` field on the registration config (`mcp.js:706` destructures it; `ToolAnnotations` = `{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }`) and forwards it verbatim in `tools/list`. Clients that read these hints (ChatGPT's connector UI is the visible case) otherwise assume the cautious default: not-read-only, destructive, open-world.

Two load-bearing Rembric invariants make the correct annotation values unambiguous:

- **Append-only memory** — rows are never `DELETE`d and `content` is never `UPDATE`d; lifecycle is `status` flips plus `replaces` links, every consolidation op journaled and reversible. Therefore **no** tool performs a destructive (irreversible) update.
- **Closed local store** — Rembric is a single SQLite file behind one Node process, not a gateway to an open external world. `openWorldHint:false` everywhere.

## Goals / Non-Goals

**Goals:**

- Every registered MCP tool advertises behavioral annotations that match reality, so annotation-aware clients render read tools as read-only and stop labeling everything destructive.
- A test pins the contract so a future tool registration can't silently regress it.
- Purely additive: no change to tool inputs, outputs, descriptions, or the four shipping clients.

**Non-Goals:**

- `outputSchema` / `structuredContent` (see Decision 3 — deferred, not rejected).
- Re-wording tool descriptions (a separate `mcp-api` requirement already governs the protocol-teaching descriptions).
- Any change to scope enforcement, session lifecycle, or DB.

## Decisions

### Decision 1 — Annotation matrix

Classify each tool and assign hints. `destructiveHint:false` and `openWorldHint:false` are universal (invariants above). `title` is a short human label for client UIs.

| Tool                       | readOnly | idempotent | rationale                                                        |
| -------------------------- | -------- | ---------- | ---------------------------------------------------------------- |
| `memory.search`            | ✅       | ✅         | pure read                                                        |
| `memory.get`               | ✅       | ✅         | pure read                                                        |
| `memory.context`           | ✅       | ✅         | read (reading does NOT clear `needs_review` by design)           |
| `memory.session_get`       | ✅       | ✅         | pure read                                                        |
| `memory.timeline`          | ✅       | ✅         | pure read                                                        |
| `memory.search_prompts`    | ✅       | ✅         | pure read                                                        |
| `memory.doctor`            | ✅       | ✅         | read-only diagnostics                                            |
| `memory.about`             | ✅       | ✅         | read-only guidance                                               |
| `memory.stats`             | ✅       | ✅         | read-only counters                                               |
| `memory.suggest_topic_key` | ✅       | ✅         | deterministic, no write                                          |
| `project.list`             | ✅       | ✅         | pure read                                                        |
| `project.current`          | ✅       | ✅         | pure read                                                        |
| `memory.save`              | ❌       | ❌         | appends a row                                                    |
| `memory.confirm`           | ❌       | ❌         | appends a confirmation event                                     |
| `memory.capture_passive`   | ❌       | ❌         | appends N rows                                                   |
| `memory.save_prompt`       | ❌       | ❌         | appends a prompt row                                             |
| `memory.session_start`     | ❌       | ❌         | opens a session                                                  |
| `memory.session_summary`   | ❌       | ✅         | latest-call-wins on the active session → idempotent in effect    |
| `memory.session_end`       | ❌       | ✅         | idempotent on already-ended sessions (existing spec)             |
| `memory.judge`             | ❌       | ❌         | closes a pending judgment (status flip, append-only, reversible) |
| `memory.compare`           | ❌       | ✅         | idempotent upsert on `(memoryIdA, memoryIdB)` (existing spec)    |
| `project.use`              | ❌       | ❌         | activates / may autocreate a project                             |

`readOnlyHint` defaults to false when omitted, but we set it **explicitly** on write tools too so the test can assert presence rather than absence, and so the matrix is self-documenting at the call site.

### Decision 2 — Where annotations live

At each `registerTool` config object, via one of three module-scope factories — `READ_ANNOTATIONS(title)`, `WRITE_ANNOTATIONS(title)`, `IDEMPOTENT_WRITE_ANNOTATIONS(title)` — invoked inline next to `description`/`inputSchema`. The factories stamp the universal invariants (`destructiveHint:false`, `openWorldHint:false`) so they cannot be mistyped per-call, while the category + title stay visible at the registration site. Rejected alternative: a central `ANNOTATIONS` map keyed by tool name — that hides the hint behind a name lookup. Also rejected: fully inline boolean literals on all 22 tools — 4 fields × 22 is duplication that invites a `destructiveHint:true` typo. The factory call (`READ_ANNOTATIONS('Search memories')`) keeps the per-tool decision adjacent while the SDK still emits real per-tool annotations; the integration test enforces global consistency.

### Decision 3 — Defer `outputSchema` (the actual ChatGPT tooltip), with rationale

ChatGPT's tooltip recommends adding `outputSchema`. It is legitimate per the MCP spec, but it is **not** additive metadata the way annotations are, and it is deliberately excluded from this change:

- **Hard contract change.** SDK 1.29.0 `mcp.js:199-208`: if a tool declares `outputSchema`, its handler **must** return `structuredContent` that validates against the schema, or the call fails with `Output validation error`. Today all handlers return `ok(payload)` = a single `text` block of `JSON.stringify(payload)` (`apps/server/src/mcp/tools.ts:117`). Adding `outputSchema` forces every one of ~25 handlers to also emit validated `structuredContent`.
- **Fragile across branches.** The payloads are dynamic: `memory.context` (`recentSessions`/`recentMemories`/`pendingJudgments`/`needsReview`/`clamped`), `memory.save` (`candidates[]`), `memory.timeline` (`fallback:"time_window"`), plus `not_found`/error shapes. A schema correct for the happy path but wrong for an edge branch passes tests and then breaks that tool in production for **all four clients**.
- **Conflicts with a repo invariant.** "Never hand-write row/DTO shapes — derive from schema types." There is no existing zod schema for tool outputs; authoring 25 by hand is exactly the duplication that invariant forbids, and it would drift from the real payloads.
- **Low marginal benefit here.** Results are already serialized JSON in the `text` block, which models parse fine. `outputSchema` mainly helps clients that _validate/render_ structured output — a real but smaller win than fixing the wrong destructive/read-only labels.

Recommendation for the operator: if `outputSchema` is still wanted after seeing this, do it as a separate spec-driven change that (a) introduces zod output schemas derived from the entity/projection types, (b) routes them through a single `ok(payload, schema)` helper that emits both `text` and `structuredContent`, and (c) backs every conditional branch and error shape with a test before flipping it on per-tool. Not safe to land unattended.

## Risks / Trade-offs

- [A client mis-reads `idempotentHint` and skips a legitimate re-call] → idempotent hints are only set where the existing specs already guarantee idempotency (`session_end`, `compare`) or where re-running is provably side-effect-free (reads, `suggest_topic_key`); `session_summary` is latest-wins so re-call is safe.
- [A future tool is added without annotations, silently regressing the contract] → mitigated by the invariant-style test that enumerates the registered tools and asserts the matrix.
- [`destructiveHint:false` on `memory.judge`/`project.use` looks aggressive] → justified: supersede is a reversible journaled `status` flip (append-only invariant), and `project.use` never deletes. Documented in the matrix so a reviewer can challenge it against the invariant, not a guess.

## Migration Plan

Single additive code change + test; no migration, no rollback complexity. Reverting is deleting the `annotations` fields. No client needs to change.

## Open Questions

- Should `title` strings be user-facing product copy reviewed by the operator, or are the terse engineering labels fine? Defaulting to terse labels matching the tool name; trivial to adjust later.
