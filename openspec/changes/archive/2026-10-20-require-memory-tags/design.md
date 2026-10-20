## Context

The operational MCP schemas and internal save API serve different callers. MCP agents must supply labels; seeds and evaluation fixtures still need tagless internal writes. Existing requirements also cover passive capture's shared curation pipeline, topic-key supersession, NUL rejection, and bounded protocol instructions.

## Goals / Non-Goals

**Goals:** require 1–64 tags on both operational memory-write tools, canonicalize supplied tags once before persistence, and teach useful reusable labels without more calls.

**Non-Goals:** taxonomy enforcement, catalogs, aliases, semantic merging, new tools, larger `memory.context` payloads, prompt-tag changes, new dependency versions, migrations, backfill, or installer/release documentation.

## Decisions

1. **Schema presence, service normalization.** Make `memorySaveSchema.tags` a required array with `.min(1).max(64)` and a concise description. Reuse that exact field in `capturePassiveSchema` in `observability-tools.ts`; no new schema module and no Zod transforms. `tools/list` must expose `required`, `minItems: 1`, `maxItems: 64`, and the label guidance. Keep `SaveMemoryInput.tags` optional internally. Requiring tags on the internal type instead would force unrelated seed/evaluation changes; schema transforms would duplicate the service policy and complicate MCP schema emission.

2. **One private normalizer in `MemoryService.saveWithTopicKey`, before any transaction.** For each supplied string: reject NUL first; apply NFKC; replace separator runs with spaces using the same `[._/\\]+` prepass as topic suggestions; call the installed `slugify` with `{ lower: true, strict: true }`; reject an empty result with `invalid_input` naming `tags`. Deduplicate normalized values preserving first occurrence. Normalize the whole array before any insert, relation write, or predecessor status change. Omitted and empty internal arrays retain their existing tagless semantics. Repository normalization would be too late to protect topic supersession; per-handler normalizers would duplicate logic.

   The owner chose existing-library ASCII transliteration instead of maintaining a Unicode word-run parser. Core declares `slugify` directly with the existing MCP range `^1.6.9`, reusing locked `1.6.9`, its integrity hash, and dependency-free snapshot. Importing MCP would create a core-to-MCP cycle and apply unrelated topic-key policy. No version upgrade, new transitive dependency, lifecycle allowance, stopword filtering, truncation, or topic-key behavior change is needed.

   Examples: `Dashboard` → `dashboard`; `Deploy / Docker` and `deploy_docker` → `deploy-docker`; `autenticación` → `autenticacion`; `Caché` → `cache`; `Ｄａｓｈｂｏａｒｄ` → `dashboard`; `C++` → `c`. Unsupported-script-only labels such as `数据库` and `部署 / 数据库` yield empty output and are rejected before any write. Composed and decomposed accented input converges through NFKC and transliteration. Already-normalized input is unchanged. `bug-fix` and `fix-bug` remain distinct: this is syntax normalization, not semantic merging.

3. **Capture carries one batch label set.** Add `tags` to the existing handler's arguments and pass it unchanged into every extracted learning's shared save pipeline. The service performs normalization. Extraction, scope/session handling, candidate aggregation, and empty-extraction behavior remain unchanged for valid tagged requests. No tag inference call or per-learning schema is introduced. Invalid supplied tags on a batch that would save learnings fail before its first write; this design does not introduce general batch atomicity.

4. **Teach the existing protocol, within existing budgets.** Server SAVE instructions and their byte-identical Hermes copy include required tags and normally 1–5 useful reusable lowercase kebab-case labels (`dashboard`, `sqlite`, `bug-fix`). The remember command supplies labels derived from its text. Tool/property descriptions expose the same guidance and bound. Preserve instruction/description caps, optional `topic_key`, session handling, and existing call counts. A catalog or mandatory suggest call adds cost without solving syntactic consistency.

5. **Scoped spec deltas, not unrelated rewrites.** Fully replace directly contradictory save and initialize requirements and the remember command requirement. Add dedicated capture-tag and Hermes tag-guidance requirements that explicitly govern abbreviated older descriptions; the dedicated operational-tag requirement explicitly supersedes the abbreviated capture signature in the large research-tools requirement without copying its unrelated context/timeline scenarios. The smaller shared-curation requirement is updated in full to require batch tags and propagation. Existing response refinements elsewhere (candidate counts, entity channels, explicit batch judgment tools) continue to apply; tag changes do not roll them back. Topic-key examples in the memory spec are illustrative partial inputs, not a waiver of the operational schema.

## Archive validation baseline

Before sync, strict validation passed for `memory`, `mcp-api`, and `hermes-agent-plugin`, but `claude-code-plugin` failed the first-body SHALL/MUST check for requirements 0, 5, and 6. The pending command delta already fixes requirement 0. Two additional full MODIFIED requirements only move their existing normative paragraph before the introductory paragraph, preserving every paragraph and scenario verbatim. These format-only changes provide delta provenance without changing protocol behavior.

## Risks / Trade-offs

- [Risk] Older callers omit tags and receive schema errors → Mitigation: advertise the required field in `tools/list`, update actual wire fixtures and remember/SAVE guidance, and verify both tools through MCP transport.
- [Risk] Bad tags could retire a valid topic predecessor → Mitigation: normalize and validate every supplied tag before opening the existing transaction; assert unchanged memories and relations after rejection.
- [Trade-off] Syntactic deduplication leaves semantic synonyms separate → Accepted because semantic merging requires a taxonomy or extra reasoning outside this scope.
- [Trade-off] Accents transliterate and unsupported-script-only labels are rejected → Accepted explicitly by the owner; preserve the pre-transaction invalid-input boundary.
- [Trade-off] Historical spellings remain inconsistent → Accepted because append-only historical reads stay unchanged; no migration or backfill is needed.
- [Risk] Blanket fixture updates conceal internal compatibility or expand review size → Mitigation: update only calls crossing changed MCP schemas; retain tagless internal tests and keep each behavior work unit targeted below 400 changed lines, splitting further if needed.

## Migration Plan

Implement service normalization, then required schemas/capture propagation, then guidance and wire-fixture alignment in focused work units, each with its regression tests. Run focused tests first, then existing instruction/parity checks and a basic local HTTP MCP smoke with a successful control. No database migration or data rewrite is required. A code rollback restores the previous optional wire contract; normalized strings remain readable by the previous version.

## Open Questions

None: mandatory operational tags, optional internal tags, existing-library ASCII normalization, unsupported-script rejection, and exclusions are approved. Exact affected test fixtures are identified during implementation without broad fixture rewrites.
