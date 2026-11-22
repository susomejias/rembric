## 1. Scanner

- [x] 1.1 `packages/core/src/services/secret-redaction.ts`: `SECRET_KINDS`, `redactSecrets`, `RedactionTally` (`redact`, `redactWithin`, `redactJson`, `list`), detectors in D2 order, procedural PEM detection.
- [x] 1.2 Tests: one positive fixture per kind, the false-positive corpus (80 entries), idempotence, structure kept for partial detectors, no entities from placeholders, 12 pathological inputs of 200,000 characters (all 120 tests in ~100 ms).

## 2. Service boundary

- [x] 2.1 `MemoryService.saveWithTopicKey` (title, content, tags, topic_key) and `confirm`/`confirmMany` (reason, both verdicts), caps cut after redaction.
- [x] 2.2 `AgentSessionsService.start`/`ensure` (agent, description, placeholder title), `writeSummary`/`end` (summary, title), `reportTurn` (title).
- [x] 2.3 `PromptsService.save` (content, title, tags).
- [x] 2.4 `RelationsService.judge`/`judgeInScope`/`compare`/`compareInScope` (reason, evidence strings at any depth).
- [x] 2.5 Service tests for each path, including the cap cut (`secret-redaction-services.test.ts`, 12 tests).

## 3. MCP surface

- [x] 3.1 `redactions` in the responses of the seven write tools (per item for `memory.judge_batch`), omitted when empty; optional in each output schema.
- [x] 3.2 One description line per write tool, within `DESCRIPTION_MAX_LENGTH`; `memory.session_summary` (1868/1900 before) carries it on its `summary` argument. `mcp-transport.test.ts` length table updated (`memory.save` 1654 → 1780, `memory.session_start` 977 → 1103).
- [x] 3.3 Docs: `docs/agents.md` privacy section and the README pointer. No plugin change: Pi discovers descriptions via `tools/list` (Pi suite 86/86 against a production build), Hermes mirrors only `initialize.instructions` (unchanged), hooks read HTTP bodies that do not change.

## 4. Coverage invariant

- [x] 4.1 `TEXT_COLUMNS` in `schema-inventory.ts`; classification test in `invariants.test.ts`.
- [x] 4.2 `secret-redaction-sweep.test.ts`: real-boundary writes, whole-database scan, embedder spy, a placeholder in every redacted column, FTS match absent.

## 5. Verification

- [x] 5.1 Mutation check (`scripts/mutate.mjs`, which gains `--workspace` for `packages/core` specs): removing each of the 17 detector entries reddens its kind's fixture test (the three `assigned_secret` forms redden the fixture or the assignment-forms test); 14 service-wiring mutations, 2 classification mutations (a dropped and a stale entry), 1 sweep mutation (an exempt column reclassified `redacted`) and 1 handler mutation (`memory.save` without `redactions`) are all caught.
- [x] 5.2 `pnpm test` (db 299, mcp 448, core 1240, web 1514 incl. the Pi suite against a production build), `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm run check:spec-provenance`, `openspec validate redact-secrets-on-write --strict` — all exit 0.

## 6. Independent verification and corrections

An independent verifier drove the real MCP and HTTP boundaries against the baseline and against the branch and reported 5 blockers and 3 should-fix items. Each was reproduced as a failing test before the fix.

- [x] 6.1 Cuts before redaction (`deriveTitle` in `memory.capture_passive`, `truncateSummary`/`truncateTitle` in the HTTP session routes) left URL passwords, Bearer tokens and `DB_PASSWORD` values whole in `memory.title`, `memory_fts.title`, `sessions.title`, `sessions.summary` and the embedder input. Fixed by redacting before every cut; a grep invariant pins it; the sweep plants secrets across each cut.
- [x] 6.2 Evidence object keys were not scanned. `redactJson` now redacts the serialized JSON (keys and `"password": "…"` pairs included) and falls back to a structural walk only if the result stops parsing; 4,000-deep nesting no longer overflows the stack.
- [x] 6.3 False positives on code and prose literals (`credentials: 'same-origin'`, `password: "Required"`, i18n strings, Helm secret names, `xoxb-test-token`, `https://oauth2:PERSONAL_ACCESS_TOKEN@…`, `GITHUB_TOKEN=TODO_FILL_ME_IN`, …): values must now be secret-shaped, `pat` is no longer a credential word, Slack tokens need a digit group, URL passwords skip env-variable names. 18 corpus entries added.
- [x] 6.4 Whole private keys survived in PGP armor, JS concatenation, JSON with `\/`, markdown quotes and bodies with comments: the body check is now base64 coverage (≥64 chars in runs ≥16 covering ≥60%), with a truncated-mode fallback.
- [x] 6.5 Quadratic PEM scanning (distinct labels 7,330 ms, far `END` 2,511 ms at 1.6M chars): one pass over headers and footers with per-label cursors; 25–36 ms after. The linear tests now assert a 1,500 ms budget, because a timeout cannot fail synchronous code.
- [x] 6.6 Placeholder hints matched inside random tokens (~0.1% of 43-char tokens survived): hints count only at a word boundary.
- [x] 6.7 A redaction could fail a curated summary merge (10,013 > 10,000): the cap is checked on the merge as sent and the redacted merge is cut.
- [x] 6.8 A discarded `memory.session_summary` (`terminal_final`) reported redactions: it reports nothing now.
- [x] 6.9 Recheck limited to these items: each fix mutated back is caught by its regression test (7 mutations, including the three HTTP routes, the capture title and the discarded summary), and all 17 detector removals are still caught.
