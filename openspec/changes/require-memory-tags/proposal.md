## Why

Operational memory writes can omit tags or store spelling variants that fragment retrieval. Require useful labels on MCP saves and normalize their syntax once at the service boundary, without a taxonomy, extra agent calls, or changes to historical data.

## What Changes

- **BREAKING**: require `tags` containing 1–64 strings on `memory.save` and `memory.capture_passive`; capture applies its batch-level tags to every extracted learning.
- Normalize supplied memory tags with NFKC, lowercase, Unicode word runs joined by hyphens, and first-occurrence deduplication. Reject NUL and tags that normalize to empty before any write or topic supersession.
- Keep internal `SaveMemoryInput.tags` optional, including empty arrays for seeds/evaluation fixtures. Keep `topic_key` optional and historical reads unchanged.
- Advertise the bound and guidance in existing schemas/instructions: normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`.
- Preserve prompt tags, existing tools/call flows, and `memory.context` shape and size. No catalogs, aliases, semantic merging, dependencies, migrations, or backfill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: canonicalize supplied tags at the shared save boundary with pre-write rejection and topic atomicity.
- `mcp-api`: mandatory operational save/capture tags, batch propagation, discoverable schema constraints, and concise agent guidance.
- `claude-code-plugin`: make the remember command supply the newly required tags.
- `hermes-agent-plugin`: keep SAVE guidance aligned with the server's required tags.

## Impact

Planned implementation surfaces: `packages/core/src/services/memory.ts` and `memory.test.ts`; `packages/mcp/src/memory-tools.ts`, `observability-tools.ts`, `instructions.ts`, and their co-located tests; `apps/plugin/commands/remember.md`; `apps/plugin/.hermes-plugin/__init__.py` and `tests/test_system_prompt_block.py`, plus existing guidance parity tests. Only transport fixtures invoking the changed schemas need required-tag updates; internal tagless fixtures remain valid. Confirm exact existing test/provider filenames before implementation.

Append-only lifecycle, service-layer scope resolution, topic-key transactional supersession, and save-time candidate/judgment behavior remain intact. No new application tools, extra calls, package edits, release/installer documentation changes, or database changes are planned. This change itself writes OpenSpec artifacts only.
