## Why

Retiring a memory is today an operator-only action: the only ways a memory leaves active recall are the dashboard `archive` button, an automatic `topic_key`/`judge` supersede (which always keeps a successor link), or the deterministic decay sweep. An agent has no way to retire a memory that has **no replacement** — even when the user explicitly asks for it ("forget this", "remove that note", "these homelab memories don't belong in my personal project"). The motivating case is a cross-project "move": recreate memories in a destination project and retire the originals in the source. Modeled as append-only primitives that is `memory.save` (copy-forward) + an archive-back the agent cannot currently perform, forcing the user to leave the agent and open the dashboard mid-task.

This change adds an agent-facing `memory.archive` MCP tool. The hard part is not the mechanism (a `status` flip already sanctioned by the append-only contract) but the **authority**: giving an LLM an unlinked retirement verb risks over-eager, autonomous cleanup that hides good memories. The tool's behavior and — load-bearingly — its description must contain that risk.

## What Changes

- **New MCP tool `memory.archive`**: flips a single in-scope, `active` memory to `archived`. Reuses the existing `MemoryService.archive(id, scope)`; adds no new mutation verb, no `content`/`title` mutation, no `DELETE`.
- **Scope-locked, single-scope**: archives only within the request's one resolved effective scope (same `resolveEffectiveScope`/`requireScope` path as every other memory tool). A cross-scope id returns `not_found`, exactly like `memory.get`/`memory.confirm`. Honors the path-scoping contract (`/mcp/<slug>` archives project scope; `/mcp` archives global; `scope_locked`/`project_required` unchanged). **No cross-project archiving.**
- **Reversible only, never purge**: archiving is the reversible `status` flip. Physical deletion stays operator/admin-only via the existing `purgeDisconnectedArchived` escape hatch — the new tool does not delete rows, drop vectors, or touch FTS.
- **Journaled**: the agent-initiated archive writes a `consolidation_ops` audit row (op_type `agent_memory_archive`) so it is attributable and reversible in the same journal the sweep and purge already use. (The dashboard archive is currently un-journaled; this change journals the agent path and MAY backfill the dashboard path for parity.)
- **Description is load-bearing anti-autopilot copy**: the tool description MUST steer the model to archive **only** on explicit user request to retire/remove a memory (including the archive-back half of a user-requested cross-project move), MUST tell it to prefer a `topic_key`/`judge` supersede whenever a replacement exists, and MUST forbid autonomous housekeeping during recall. Enforced by a spec scenario asserting the description contains the guard wording.
- Plugin tool-surface docs updated to list `memory.archive` with the same "only at explicit user request" framing.

## Capabilities

### New Capabilities

<!-- none: this extends existing memory + MCP surfaces -->

### Modified Capabilities

- `memory`: adds a requirement that an in-scope active memory MAY be archived by the agent at explicit user request, as a reversible journaled `status` flip that never deletes, never crosses scope, and is distinct from supersede (no successor link).
- `mcp-api`: adds the `memory.archive` tool to the MCP surface (inputs, scope enforcement, error conventions) and a description-contract requirement that the tool's description carries the anti-autonomous-retirement guidance.

## Impact

- **Code**: `apps/server/src/mcp/memory-tools.ts` (register `memory.archive`, zod input, description copy; `MemoryToolDeps` already exposes the memory service). `apps/server/src/services/memory.ts` (journal the archive event; keep `archive(id, scope)` signature). `apps/server/src/db/repositories/memory-repository.ts` / `consolidation` repo (new `agent_memory_archive` op_type journaling). Possibly `apps/server/src/dashboard/memories.ts` for journaling parity.
- **Specs**: delta files under `openspec/changes/add-mcp-memory-archive/specs/{memory,mcp-api}/spec.md`.
- **Docs / plugin**: MCP tool-surface documentation and any client-facing tool listing under `apps/plugin/` that enumerates tools.
- **Tests**: MCP tool tests (scope-lock, not_found on cross-scope id, conflict on non-active, journaling), and a description-contract test mirroring the existing "protocol-teaching descriptions" scenario style.
- **Invariants touched**: append-only (archive is an already-sanctioned `status` flip — not weakened), scope-at-service (reused unchanged), judgment-freshness (archive is explicitly the no-successor path, distinct from supersede). No load-bearing invariant is relaxed; the physical-purge escape hatch is untouched.
