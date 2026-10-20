## Context

The operational MCP schemas and internal save API serve different callers. MCP agents must supply labels; seeds and evaluation fixtures still need tagless internal writes. Existing requirements also cover passive capture's shared curation pipeline, topic-key supersession, NUL rejection, and bounded protocol instructions.

## Goals / Non-Goals

**Goals:** require 1–64 tags on both operational memory-write tools, canonicalize supplied tags once before persistence, and teach useful reusable labels without more calls.

**Non-Goals:** taxonomy enforcement, catalogs, aliases, semantic merging, transliteration, new tools, larger `memory.context` payloads, prompt-tag changes, dependencies, migrations, backfill, or installer/release documentation.

## Decisions

1. **Schema presence, service normalization.** Make `memorySaveSchema.tags` a required array with `.min(1).max(64)` and a concise description. Reuse that exact field in `capturePassiveSchema` in `observability-tools.ts`; no new schema module and no Zod transforms. `tools/list` must expose `required`, `minItems: 1`, `maxItems: 64`, and the label guidance. Keep `SaveMemoryInput.tags` optional internally. Requiring tags on the internal type instead would force unrelated seed/evaluation changes; schema transforms would duplicate the service policy and complicate MCP schema emission.

2. **One private normalizer in `MemoryService.saveWithTopicKey`, before any transaction.** For each supplied string: reject NUL first; apply NFKC then locale-independent lowercase; take word runs starting with a Unicode letter or number and continuing with letters, numbers, or combining marks (`[\p{L}\p{N}][\p{L}\p{N}\p{M}]*` with Unicode/global matching); join runs with `-`; reject an empty result with `invalid_input` naming `tags`. Deduplicate normalized values preserving first occurrence. Normalize the whole array before any insert, relation write, or predecessor status change. Omitted and empty internal arrays retain their existing tagless semantics. Repository normalization would be too late to protect topic supersession; per-handler normalizers would duplicate logic. ASCII slug libraries would lose accents and CJK unnecessarily.

   Examples: `Dashboard` → `dashboard`; `Deploy / Docker` and `deploy_docker` → `deploy-docker`; `autenticación` → `autenticación`; `部署 / 数据库` → `部署-数据库`; `Ｄａｓｈｂｏａｒｄ` → `dashboard`. Canonically equivalent accented input converges through NFKC. Already-normalized input is unchanged. `bug-fix` and `fix-bug` remain distinct: this is syntax normalization, not semantic merging.

3. **Capture carries one batch label set.** Add `tags` to the existing handler's arguments and pass it unchanged into every extracted learning's shared save pipeline. The service performs normalization. Extraction, scope/session handling, candidate aggregation, and empty-extraction behavior remain unchanged for valid tagged requests. No tag inference call or per-learning schema is introduced. Invalid supplied tags on a batch that would save learnings fail before its first write; this design does not introduce general batch atomicity.

4. **Teach the existing protocol, within existing budgets.** Server SAVE instructions and their byte-identical Hermes copy include required tags and normally 1–5 useful reusable lowercase kebab-case labels (`dashboard`, `sqlite`, `bug-fix`). The remember command supplies labels derived from its text. Tool/property descriptions expose the same guidance and bound. Preserve instruction/description caps, optional `topic_key`, session handling, and existing call counts. A catalog or mandatory suggest call adds cost without solving syntactic consistency.

5. **Scoped spec deltas, not unrelated rewrites.** Fully replace directly contradictory save and initialize requirements and the remember command requirement. Add dedicated capture-tag and Hermes tag-guidance requirements that explicitly govern abbreviated older descriptions; the dedicated operational-tag requirement explicitly supersedes the abbreviated capture signature in the large research-tools requirement without copying its unrelated context/timeline scenarios. The smaller shared-curation requirement is updated in full to require batch tags and propagation. Existing response refinements elsewhere (candidate counts, entity channels, explicit batch judgment tools) continue to apply; tag changes do not roll them back. Topic-key examples in the memory spec are illustrative partial inputs, not a waiver of the operational schema.

## Risks / Trade-offs

- [Risk] Older callers omit tags and receive schema errors → Mitigation: advertise the required field in `tools/list`, update actual wire fixtures and remember/SAVE guidance, and verify both tools through MCP transport.
- [Risk] Bad tags could retire a valid topic predecessor → Mitigation: normalize and validate every supplied tag before opening the existing transaction; assert unchanged memories and relations after rejection.
- [Trade-off] Syntactic deduplication leaves semantic synonyms separate → Accepted because semantic merging requires a taxonomy or extra reasoning outside this scope.
- [Trade-off] Historical spellings remain inconsistent → Accepted because append-only historical reads stay unchanged; no migration or backfill is needed.
- [Risk] Blanket fixture updates conceal internal compatibility or expand review size → Mitigation: update only calls crossing changed MCP schemas; retain tagless internal tests and keep each behavior work unit targeted below 400 changed lines, splitting further if needed.

## Migration Plan

Implement service normalization, then required schemas/capture propagation, then guidance and wire-fixture alignment in focused work units, each with its regression tests. Run focused tests first, then existing instruction/parity checks and a basic local HTTP MCP smoke with a successful control. No database migration or data rewrite is required. A code rollback restores the previous optional wire contract; normalized strings remain readable by the previous version.

## Open Questions

None: mandatory operational tags, optional internal tags, Unicode normalization, and exclusions are approved. Exact affected test fixtures are identified during implementation without broad fixture rewrites.
