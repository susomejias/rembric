## 1. Scanner

- [ ] 1.1 `packages/core/src/services/secret-redaction.ts`: `SECRET_KINDS`, `redactSecrets`, `RedactionTally` (`redact`, `redactJson`, `list`), detectors in D2 order, procedural PEM detection.
- [ ] 1.2 Tests: one positive fixture per kind, the false-positive corpus, idempotence, structure kept for partial detectors, pathological inputs.

## 2. Service boundary

- [ ] 2.1 `MemoryService.saveWithTopicKey` (title, content, tags, topic_key) and `confirm`/`confirmMany` (reason, both verdicts), caps cut after redaction.
- [ ] 2.2 `AgentSessionsService.start`/`ensure` (agent, description), `writeSummary`/`end` (summary, title), `reportTurn` (title).
- [ ] 2.3 `PromptsService.save` (content, title, tags).
- [ ] 2.4 `RelationsService.judge`/`judgeInScope`/`compare`/`compareInScope` (reason, evidence strings at any depth).
- [ ] 2.5 Service tests for each path, including the cap cut.

## 3. MCP surface

- [ ] 3.1 `redactions` in the responses of the seven write tools (per item for `memory.judge_batch`), omitted when empty; optional in each output schema.
- [ ] 3.2 One description line per write tool, within `DESCRIPTION_MAX_LENGTH`.
- [ ] 3.3 Docs: `docs/agents.md` privacy section (server-side redaction applies to every client, beside the client-side `<private>` tags) and the README pointer. No plugin change: Pi discovers descriptions via `tools/list`, Hermes mirrors only `initialize.instructions` (unchanged), hooks read HTTP bodies that do not change.

## 4. Coverage invariant

- [ ] 4.1 `TEXT_COLUMNS` in `schema-inventory.ts`; classification test in `invariants.test.ts`.
- [ ] 4.2 `secret-redaction-sweep.test.ts`: real-boundary writes, whole-database scan, embedder spy, a placeholder in every redacted column, FTS match absent.

## 5. Verification

- [ ] 5.1 Mutation check: removing each detector reddens its fixture test (`scripts/mutate.mjs`).
- [ ] 5.2 `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `openspec validate redact-secrets-on-write --strict`.
