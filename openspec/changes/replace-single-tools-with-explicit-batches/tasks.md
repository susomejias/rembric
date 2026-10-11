## 1. Contract and scope

- [x] 1.1 Inventory the four tool registrations, existing semantics and active client/instruction consumers; exclude unrelated work and historical changelogs.
- [x] 1.2 Specify batch-only names, bounds, preserved history, associated item errors, all-failed MCP errors, scope masking and unchanged mutation transactions in proposal/design/specs.
- [x] 1.3 Validate the initial delta specs with `openspec validate replace-single-tools-with-explicit-batches --strict`.
- [x] 1.4 Amend and revalidate contracts for direct session-period retrieval, simple limit(max20)/offset read pagination and 20-item mutation calls; preserve complete content without introducing byte budgets, fragmentation, special cursors or additional tools.

- [x] 1.5 Define and implement createdAt-based from/to selection for memory.get_batch, matching session read limit/offset and complete-result envelopes; keep confirmation and judgment mutations explicitly item-selected.
- [x] 1.6 Execute scoped period-query index audit at1k/20k/50k rows with EXPLAIN QUERY PLAN and measured alternatives; reproduce decisive evidence before adding any index/migration.

## 2. Server implementation and regression evidence

- [x] 2.1 Add failing real-MCP tests for discovery of the four replacements, absence of old names, strict arrays and refusal of singular/unknown inputs, each with a passing valid-input control.
- [x] 2.2 Replace schemas and handlers for read, confirm and judge, preserving required collection/count output schemas and keeping the other tools unchanged.
- [x] 2.3 Reuse service history assembly so every memory read entry retains head, bounded content-free predecessors, confirmation count, annotations, entities and requested-row review metadata while advancing each successful target's resolved-head access signal for both one-item and multi-item batches; failed, foreign and merely projected predecessor rows remain untouched and reading does not clear needs_review.
- [x] 2.4 Test both reads with mixed valid/missing/foreign/deleted IDs, duplicates, one-item success, one-item failure, all-failed multi-item batches and sanitized item-local failures; assert valid data survives beside associated errors and `isError` is true only when no item succeeds.
- [x] 2.5 Verify confirmation rollback, deduplication, head resolution, attribution and refutation; verify judgment ordering, duplicates, strict nested validation, supersedes effects, independent failure outcomes, mixed-success non-error signaling and all-failed MCP errors for one-item and multi-item judgment batches.
- [x] 2.6 Mutation-test each new guard, including partial-success preservation, all-failed error signaling and scope masking, proving named tests fail when the guard is weakened.

## 3. Coordinated consumer migration

- [x] 3.1 Update MCP initialize instructions, tools/list descriptions and nested schema descriptions, plus shared JS/shell/Python reminders: teach canonical/provider-safe batch names, arrays, session period selection, limit(max20)/offset pagination, complete content and partial/all-failed errors; remove retired runtime recommendations and aliases.
- [x] 3.2 Migrate Claude Code/Codex shared commands, Hermes, opencode and Pi consumers, recovery examples, fixtures and affected tests; verify dynamic discovery forwards arrays unchanged.
- [x] 3.3 Update active guides, READMEs, commands, examples and agent-facing instructions in the same change; include a weekly-work query example, page continuation and per-item error handling, plus coordinated server/plugin upgrade and rollback. Do not rewrite historical changelogs or archived changes. Documentation is a completion gate, not a deferred follow-up.
- [x] 3.4 Assert all five client instruction paths retain read-before-rewrite and shared reminder identity; verify actual MCP initialize/tools/list output reflects the new schemas and semantics within existing description caps, with no removed tool-name or singular-argument recommendation.

## 4. Verification

- [x] 4.1 Run affected package/plugin/transport tests, then full tests, typecheck, lint and formatting checks; retain exact results and distinguish unrelated failures.
- [x] 4.2 Probe changed TypeScript files with active LSP diagnostics rather than relying on an empty diagnostic cache.
- [x] 4.3 Run isolated local-server MCP and plugin round trips with the new names, mixed read outcomes and one-item failure controls, following the plugin e2e playbook without production credentials.
- [x] 4.4 Read back the complete diff, verify the four old registrations are absent, preserve unrelated pre-existing changes and record verification without committing or pushing.

## Verification record

- Full `pnpm test`: DB289, core1011, MCP440 and web1182 passed (2922 TypeScript tests;16 skipped), followed by Hermes97 passed. Completed log: `/tmp/rembric-batch-all-tests.log`. A redundant later run in `/tmp/rembric-batch-final-tests.log` was stopped by its100-second harness timeout; it is not a completed full run.
- Final source-backed MCP transport:108 passed, `/tmp/rembric-batch-full-transport.log`; command-schema tests19, opencode handlers75, Pi83 and shared reminder tests50 executed. opencode handler coverage uses mocks, not a live host TUI.
- Typecheck7 tasks, fresh production build, ESLint and changed-file/OpenSpec Prettier passed. Global Prettier flags only protected pre-existing `.pi/subagents/db-performance-auditor.md`; do not reformat it. Active LSP primary error checks confirmed5 changed files clean; earlier broader checks had informational/style findings and2 inconclusive outcomes, not a workspace-clean verdict.
- Real isolated `next dev` HTTP/auth/MCP/serialization probe:22 memory rows paged20+2,27000-byte memory content and26811-byte current summary preserved; mixed and all-failed reads, strict selectors, confirmation rollback and ordered independent judgments checked. Claude/Codex hooks and Hermes provider used real HTTP; Pi proxy uses the fresh `next start` integration suite. Script/log: `/tmp/rembric-batch-dev-smoke.{mjs,log}`. Own server stopped and temporary data removed.
- Controlled mutations caught result/error signaling, masked scope, selectors/dedup/access, date boundaries/order/content presence, service guards and20-item caps. Missing session-dedup/content-presence coverage was corrected and the formerly surviving mutations then failed their named tests; sources restored. Evidence: `/tmp/rembric-{core-batch-mutations-summary,batch-result-mutations,batch-error-mutations,memory-selector-guards,session-guards-mutations,session-window-guards,session-content-guard,batch-memory-caps,batch-session-caps,batch-judge-cap}.log`.
- Index alternatives measured at1k/20k/50k and decisive results independently reproduced: `/tmp/rembric-period-audit.KgbD2z/verified/`, `/tmp/rembric-parent-period-dPIFLc/parent-actual-repeat.json`. These are service/SQL instruments, not HTTP or production performance claims.
- Strict OpenSpec validation, diff whitespace and protected-file SHA-256 checks passed. Historical changelogs/archived changes unchanged. `.env.example` remains untouched because of the sensitive-path restriction; no workaround or credential rotation. No commit, push, deployment or archive performed.
