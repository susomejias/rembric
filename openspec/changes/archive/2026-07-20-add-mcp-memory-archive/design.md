## Context

Memory is append-only: rows are never `DELETE`d and `content`/`title` are never `UPDATE`d; the lifecycle is `status` flips (`active → superseded | archived`) plus `replaces` links. The `active → archived` flip already exists via `MemoryService.archive(id, scope)` (`apps/server/src/services/memory.ts:402` → `MemoryRepository.markArchived`), but it is reachable ONLY from the operator dashboard (`apps/server/src/dashboard/memories.ts`) and from the deterministic decay sweep. The consolidation sweep journals its archives through `consolidation_ops`; the dashboard `archive` currently does **not** journal.

Agents can only retire a memory indirectly, and only _with_ a successor: a `topic_key` upsert or a `memory.judge` supersede. There is no agent path to retire a memory that has no replacement, even at explicit user request. The concrete driver is a cross-project "move": copy-forward with `memory.save` into the destination project, then archive the original in the source project.

## Goals / Non-Goals

**Goals:**

- Give the agent a `memory.archive` MCP tool that flips one in-scope `active` memory to `archived`.
- Keep it strictly within the append-only contract: reversible `status` flip, no delete, no `content`/`title` mutation, no `memory_vec`/`memory_fts` drop.
- Enforce the existing single-effective-scope model unchanged (no cross-project archive); reuse `resolveEffectiveScope`/`requireScope`.
- Journal the agent-initiated archive so it is attributable and reversible.
- Make the tool description do the heavy lifting of preventing autonomous, unlinked retirement — the primary risk of exposing this verb.

**Non-Goals:**

- No physical deletion / purge from the agent surface — `purgeDisconnectedArchived` stays operator/admin-only.
- No cross-project or cross-scope archive; no "move" tool that rewrites `project_id`/`partition_key`.
- No agent-facing `unarchive`/undo (revert stays on the operator dashboard). Reversibility is a property, not a new agent verb.
- No change to supersede, `topic_key`, decay sweep, or candidate detection.
- No bulk archive in this change (single id keeps the blast radius and the misuse surface small).

## Decisions

**1. Reuse `MemoryService.archive(id, scope)`; do not add a mutation verb.** The service method already does the scope check (`memoryMatchesScope`), the `active`-only guard (throws `conflict` otherwise), and `markArchived`. The MCP tool is thin wiring. This keeps the append-only surface identical to what the dashboard already exercises.

**2. Journal the archive inside the service, in the same transaction as the flip.** Add a `consolidation_ops` row with `op_type = 'agent_memory_archive'` and `affected_ids = [id]`. This mirrors how the sweep and the purge journal, makes agent retirements auditable in one place, and gives revert a handle. The dashboard `archive` path MAY be routed through the same journaling for parity — decided during apply, but the agent path MUST journal. `op_type` is a free-text-ish column; adding a new value needs no migration (verify no CHECK constraint on `consolidation_ops.op_type` before relying on this).

**3. Single-scope resolution, `not_found` on cross-scope, `conflict` on non-active.** Identical error semantics to `memory.confirm`/`memory.get`. The tool never resolves two scopes; there is deliberately no way to name a source and a destination project. A "move" is composed by the agent from `memory.save` (in the destination connection/scope) + `memory.archive` (in the source), each a single-scope op.

**4. The description is a spec-tested contract, not prose.** Following the existing "protocol-teaching descriptions" requirement style in `mcp-api`, the `memory.archive` description MUST: (a) gate use on explicit user request to retire/remove/forget; (b) prefer `topic_key`/`memory.judge` supersede when a replacement exists (archive = no-successor path); (c) forbid autonomous cleanup during recall/save; (d) note reversibility from the dashboard. A `tools/list` scenario asserts the guard substrings, so a future edit that strips the guard fails CI. Rationale: the mechanism is safe and reversible; the only real hazard is an over-eager model hiding good memories, and that hazard lives entirely in _when_ the model chooses to call it — which only the description governs.

**5. Reversible-by-design, not purge.** Archived rows stay present; the schema comment already sanctions the undo flip back to `active`. The agent tool intentionally exposes only the forward flip; recovery is an operator action, which preserves the producer/curator separation for the destructive direction while unblocking the common "retire this" ask.

## Risks / Trade-offs

- **Over-eager autonomous archiving (primary risk).** Mitigated by the description contract + spec scenario, the reversibility of archive (recoverable from the dashboard), and the journal (every agent archive is attributable). Residual risk: a model ignores the description. Accepted because the action is non-destructive and auditable; if abuse is observed, a follow-up could gate the tool behind a token capability.
- **Description drift.** A future contributor could soften the guard copy. Mitigated by the `tools/list` substring scenario that fails CI.
- **Journaling parity gap.** If only the agent path journals, dashboard and agent archives look different in `consolidation_ops`. Low stakes; the apply step decides whether to backfill the dashboard path. No data-integrity impact either way.
- **`op_type` enum.** If `consolidation_ops.op_type` turns out to be constrained by a CHECK, adding `agent_memory_archive` becomes a table-rebuild migration. Verify first; if so, follow the documented SQLite rebuild dance.
- **Scope confusion in the agent's mental model of a "move".** The agent must run save-in-destination and archive-in-source as two scoped steps; there is no atomic move. This is a deliberate simplicity/safety trade-off over an in-place `project_id` rewrite (which would also force a `memory_vec.partition_key` rewrite and cross-scope graph surgery on `memory_relations`/`replaces`).
