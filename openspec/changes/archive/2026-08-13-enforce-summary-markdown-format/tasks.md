## 1. Preserve the working tree and establish the canonical source

- [x] 1.1 Record `git status --short` before implementation and preserve the pre-existing unstaged edit in `apps/server/src/mcp/summary-rubric.ts`; do not reset, overwrite, or attribute unrelated working-tree changes to this change.
- [x] 1.2 Complete `SUMMARY_SECTIONS` as the one server definition of the exact six level-2 Markdown headings (`## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, `## Files`), in order, explicitly requiring one heading per line and prohibiting a flat paragraph.
- [x] 1.3 Update `apps/server/src/mcp/instructions.ts` and `apps/server/src/mcp/server.ts` to use the canonical directive; reclaim surrounding initialize prose until both scoped and unscoped outputs are ≤1000 characters without losing SAVE, RECALL, summary replacement/current-first, session-id, scope, or `memory.about` obligations.
- [x] 1.4 Extend MCP instruction and live `tools/list` tests to assert the exact heading directive, verify `memory.session_summary` stays below `DESCRIPTION_MAX_LENGTH`, and verify both initialize variants stay at or below 1000 characters.

## 2. Update the one shared plugin protocol for all five clients

- [x] 2.1 Update `apps/plugin/test/nudge-fixtures.json` first, then make `apps/plugin/scripts/prompt-nudge.sh`, `apps/plugin/bin/rembric-plugin-core.mjs`, and every summary-guidance path in `apps/plugin/.hermes-plugin/__init__.py` match its canonical summary strings exactly; do not add a private opencode or Pi copy.
- [x] 2.2 Update the shared post-compaction text in `apps/plugin/scripts/post-compact.sh`, the JS/TS core, and Hermes so it retains read-then-rewrite ordering and `10000`, adds the exact separate-line heading directive, and emits ≤700 UTF-8 bytes.
- [x] 2.3 Update the end-of-turn rubric in `apps/plugin/scripts/stop-nudge.sh` and the summary command in `apps/plugin/commands/summary.md`; preserve current-complete-state, reasons/evidence, verbatim-fact, unfinished-work, and replacement guidance while removing every bare flat rubric occurrence.
- [x] 2.4 Confirm Claude Code and Codex still reuse the same bash files, opencode and Pi still import the same JS/TS core/resources, and Hermes remains the only required Python copy; `git ls-files apps/plugin/` SHALL show no duplicated shared nudge resource.

## 3. Lock the format and budgets with regression tests

- [x] 3.1 Extend `apps/plugin/test/nudge-fixtures.test.ts` so actual bash output, the shared JS/TS exports, Hermes wrappers/system prompt, post-compaction text, end-of-turn rubric, and command text all carry the exact six headings in order plus the separate-line instruction.
- [x] 3.2 Strengthen `apps/server/src/test/invariants.test.ts::"the session-summary rubric has one source"` to retain the exact eight-file tracked-surface enumeration and reject a missing/reordered/renamed/appended heading, any second flat occurrence in a multi-path file, and the old bare `Goal · … · Files` fragment.
- [x] 3.3 Add or update Claude/Codex hook, Hermes Python, opencode, and Pi tests so each client's real delivery adapter is covered through its shared resource rather than by five duplicated expected strings.
- [x] 3.4 Measure the final fixture bytes with the pinned UTF-8-bytes÷4 proxy and update assertions together with the text: `summary` ≤400 bytes, `postCompact` ≤700 bytes, turn-1-with-recall ≤800 bytes/200 tokens, divergent-counter firing ≤960 bytes/240 tokens, and ten-turn amortised ≤180 bytes/45 tokens; record the exact observed values in the implementation evidence.
- [x] 3.5 Run mutation proofs that restore the flat rubric in one surface, remove one `##`, reorder headings, and append an extra heading; each mutation MUST make the focused invariant/fixture suite fail, after which every file is restored byte-identically.

## 4. Focused verification

- [x] 4.1 Run `pnpm vitest run apps/plugin/test/nudge-fixtures.test.ts apps/plugin/test/prompt-nudge.test.ts apps/plugin/test/stop-nudge.test.ts apps/plugin/.opencode-plugin/plugin.test.ts apps/plugin/.pi-plugin/plugin.test.ts` and record the passing test count.
- [x] 4.2 Run the Hermes Python suite, including `test_system_prompt_block.py`, `test_prefetch_and_sync_turn.py`, and `test_post_compact_directive.py`, and record the passing test count.
- [x] 4.3 Run `pnpm vitest run apps/server/src/mcp/instructions.test.ts apps/server/src/test/mcp-integration.test.ts apps/server/src/test/invariants.test.ts` with the plugin changes staged so the tracked-file completeness grep sees them; record the passing test count.
- [x] 4.4 Sweep `README.md`, `docs/agents.md`, `apps/plugin/README.md`, each in-plugin README, and changelog inputs for a restated flat summary schema; update only a model/operator-facing format statement that would otherwise contradict the canonical directive, and do not create client-specific copies.

## 5. Real Docker and five-client end-to-end smoke

- [x] 5.1 **Operator/e2e:** Start `pnpm run dev:docker:up` against pre-existing seeded data, wait for `[bootstrap] listening on`, capture the generated demo credential without writing it to tracked files, and record the pre-smoke session/memory counts.
- [x] 5.2 **Operator/e2e:** Capture the emitted summary instruction through each of the five delivery paths: Claude Code hook, Codex hook, Hermes provider, opencode handler/shared core, and Pi extension/shared core. Use the repository's supported direct hook/handler invocation when an interactive host cannot be automated; name the exact path used and explicitly disclose any real CLI that was unavailable. Every captured instruction MUST name the same six `##` headings and require separate lines.
- [x] 5.3 **Operator/e2e:** Through the real MCP/session boundary, create one smoke session and submit a canonical six-heading summary; read it back and fetch `/dashboard/sessions/<id>` to verify six separate `<h2>` sections appear in order. Submit a flat dot-separated control in a second smoke session and verify it does not falsely render as those six heading sections.
- [x] 5.4 **Operator/e2e:** Confirm pre-existing seeded sessions and memories remain readable and counts change only by the deliberate smoke rows; tear down the dev stack, uninstall any temporary client installation, restore local client configuration, and remove scratch credentials/files.

## 6. Full validation and handoff

- [x] 6.1 Run `openspec validate enforce-summary-markdown-format --strict` and the repository delta freshness/cross-reference checks; resolve every warning or error.
- [x] 6.2 Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm test` with no bypassed hooks. `pnpm run eval` is not required because retrieval, ranking, embeddings, and the evaluation corpus are untouched; record that exemption rather than silently omitting the command.
- [x] 6.3 Review `git diff --check`, `git status --short`, and the final diff: production changes SHALL be limited to the server/plugin guidance and tests described here, no dashboard renderer or persistence code SHALL change, shared plugin resources SHALL remain single-copy, and the original `summary-rubric.ts` edit SHALL remain preserved in the resulting implementation.
- [x] 6.4 Record exact byte/character measurements, focused/full test counts, the five client paths exercised, Docker seed-data controls, and any unavailable real CLI in the implementation report; do not hand-edit release versions because release-please owns the unified plugin and server carriers.
