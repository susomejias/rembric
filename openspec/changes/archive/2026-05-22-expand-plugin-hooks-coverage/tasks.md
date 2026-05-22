## 1. Shared scripts (Claude Code + Codex CLI)

- [x] 1.1 Create `apps/plugin/scripts/pre-compact.sh`. Source `_api.sh` and `_transcript.sh`. Read `session_id`, `cwd`, `transcript_path` from stdin JSON via existing helpers. Resolve slug via `rembric_read_project_slug "$CWD"`. If both session_id and slug resolve AND `transcript_path` exists, format the transcript via `rembric_format_transcript_claude_code` and derive a title from the first non-empty assistant message via `rembric_extract_first_assistant_claude_code`. POST `/api/<slug>/sessions/<session_id>/summary` with `{"summary":"...", "title":"...", "final":false}` (omit title if derivation failed). Exit `0` on any error. NO stdout (not context-injected). Mode 755.
- [x] 1.2 Create `apps/plugin/scripts/post-compaction.sh`. Source `_api.sh`. Read `session_id`, `cwd`, and `compaction_summary` from stdin JSON. Add a new helper to `_api.sh`: `rembric_compaction_summary_from_stdin_json` (mirror of the existing session_id/cwd extractors). Resolve slug. If session_id, slug, and compaction_summary all present, POST `/api/<slug>/sessions/<session_id>/summary` with `{"summary":"<compaction_summary>","final":false}`. If `compaction_summary` is empty/missing, POST `/summary {}` and write a stderr diagnostic. Exit `0` on any error. NO stdout. Mode 755.
- [x] 1.3 Verify Codex `PreCompact` stdin shape: read `codex-rs/hooks/src/engine/output_parser.rs::parse_pre_compact` (`PreCompactCommandOutputWire`) AND `codex-rs/hooks/src/schema.rs` for the **input** (stdin) wire shape. Confirm fields `session_id` (or `sessionId`), `cwd`, `transcript_path`, `compaction_trigger`. Document any divergence from Claude Code in a stderr diagnostic comment at the top of `pre-compact.sh`.
- [x] 1.4 Verify Codex `PostCompact` stdin shape: same procedure for `parse_post_compact` and confirm `compaction_summary` field name. Document any divergence in `post-compaction.sh`.

## 2. Claude Code hook wiring

- [x] 2.1 Edit `apps/plugin/hooks/hooks.json`. Add a `PreCompact` entry (`type: command`, command invokes `pre-compact.sh` with the `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` env prefix like the existing entries) and a `PostCompact` entry (same shape, invokes `post-compaction.sh`). Neither needs a matcher — both fire on every compact.
- [x] 2.2 Sharpen the nudge in `apps/plugin/scripts/post-compact.sh` (the existing SessionStart compact script — NOT to be confused with the new `post-compaction.sh`). Replace the current point 2 "Si necesitás más contexto: memory.context" with a stronger imperative form: "Si el summary que ves arriba no contiene el detalle que necesitás (file paths exactos, decisiones técnicas concretas, errores específicos previos), llamá memory.context o memory.search ANTES de responder." Stay under the existing 120-token output cap.

## 3. Codex CLI hook wiring

- [x] 3.1 Edit `apps/plugin/hooks/hooks.codex.json`. Add a `PreCompact` entry invoking the shared `pre-compact.sh` (NO `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` prefix — Codex forwards those via `env_vars` per the codex-distribution spec). Add a `PostCompact` entry invoking the shared `post-compaction.sh`.

## 4. opencode plugin changes

- [x] 4.1 In `apps/plugin/.opencode-plugin/plugin.ts`, extend the `event` dispatcher to handle `event.type === "session.compacted"`. Extract `sessionID` from `event.properties` (or fall back to `props.info.id`). If the id is in `subAgentSessions` or not in `knownSessions`, return. Otherwise, await `flushSessionSummary(sessionId)` (reusing the existing helper). Add a stderr diagnostic `[rembric] session.compacted sessionId=<id>` for observability parity with the existing diagnostics.
- [x] 4.2 In the same file's `chat.message` handler, detect when the extracted user text matches `/remember|recall|acordate|qué hicimos|what did we do/i`. When it matches, append a `{type: "text", text: "rembric: User intent: recall. Call memory.search with the user keywords before responding."}` entry to `output.parts`. Behaviour parallels the Claude Code `UserPromptSubmit` regex; the nudge string is verbatim from `apps/plugin/scripts/prompt-search.sh:7`.
- [x] 4.3 In the same file's `experimental.session.compacting` handler, extend the existing pushed string to include a final sentence directing the agent to call `memory.context` if specific detail from before compaction is needed. Stay within reasonable token budget (the string is already ~250 tokens; add ≤40 more).
- [x] 4.4 Add tests in `apps/plugin/.opencode-plugin/plugin.test.ts`:
  - `session.compacted` handler flushes the accumulator (mock `flushSessionSummary` and assert called once with the sessionID).
  - `session.compacted` handler skips sub-agent sessions.
  - `chat.message` handler appends the recall nudge when the regex matches (3-4 cases covering different keywords).
  - `chat.message` handler does NOT append the nudge when the regex does not match.
  - `experimental.session.compacting` handler includes the new `memory.context` substring.

## 5. Hermes plugin changes

- [x] 5.1 Edit `apps/plugin/.hermes-plugin/__init__.py::RembricMemoryProvider.system_prompt_block`. Extend the returned string to include guidance about calling `memory.context` when fine detail is needed after a compaction event. STAY UNDER the 300-char cap mandated by the `hermes-agent-plugin` spec ("system_prompt_block SHALL return a single-paragraph block (≤300 chars)").
- [x] 5.2 Add a test under `apps/plugin/.hermes-plugin/tests/` asserting the new substring is present and the total length is ≤300 chars.

## 6. MCP initialize.instructions tweak

- [x] 6.1 Edit `apps/server/src/mcp/instructions.ts`. Add a short clause to the existing instructions block guiding post-compact agents to call `memory.context` when the compacted summary lacks needed detail. Maximum 60 chars of new content. The line MUST fit within the existing 800-char cap.
- [x] 6.2 Update `apps/server/src/mcp/instructions.test.ts` to assert (a) the new substring is present, (b) the 800-char cap is still respected, (c) the existing assertion set still passes.

## 7. Spec sync

- [x] 7.1 Verify the proposal's "Modified Capabilities" list matches the spec delta files in `openspec/changes/expand-plugin-hooks-coverage/specs/`. There SHALL be 5 delta files: `claude-code-plugin/spec.md`, `codex-distribution/spec.md`, `opencode-plugin/spec.md`, `hermes-agent-plugin/spec.md`, `mcp-api/spec.md`.
- [x] 7.2 Run `openspec validate expand-plugin-hooks-coverage --strict` and confirm it passes.

## 8. Validation gates

- [x] 8.1 Run `pnpm run typecheck` from the repo root. SHALL produce zero errors.
- [x] 8.2 Run `pnpm run lint` from the repo root. SHALL produce zero errors for in-scope files.
- [x] 8.3 Run `pnpm test` from the repo root. SHALL produce zero failures. New tests appear in the suite count.
- [x] 8.4 Run the Hermes plugin tests (`apps/plugin/.hermes-plugin/tests/` per the existing pattern). SHALL produce zero failures. The new `system_prompt_block` test appears in the count.
- [ ] 8.5 Manual smoke against `pnpm run dev:docker:up` per `apps/server/src/skills/rembric-plugin-development/references/e2e-walkthrough.md` (referenced via the `rembric-plugin-development` skill):
  - Claude Code: trigger a /compact, verify `/api/<slug>/sessions/<id>/summary` is POSTed twice (once from PreCompact, once from PostCompact), and the dashboard /sessions row shows the resulting summary.
  - opencode: trigger a compaction, verify `flushSessionSummary` fires on `session.compacted` AND the existing `experimental.session.compacting` nudge still appears.
  - opencode: send a user message containing "qué hicimos ayer", verify the recall nudge appears in the agent's context.

## 9. Land

- [ ] 9.1 Commit on the feature branch `feat/expand-plugin-hooks-coverage` (already created via worktree). Use a Conventional Commit message in the form `feat(plugin): wire pre/post-compact hooks across Claude Code, Codex CLI, opencode + cross-client recall paridad and prompt refinements`. Per-file scoping: changes under `apps/plugin/bin/`, `apps/plugin/hooks/`, `apps/plugin/scripts/` will cascade `claude-code-plugin` and `codex-plugin` via the `bridge-bundlers` linked group; changes under `apps/plugin/.opencode-plugin/` and `apps/plugin/.hermes-plugin/` will bump their respective independent components.
- [ ] 9.2 Open a PR against `main`. Body links to this change directory and explains the source-verified Codex correction (PreCompact / PostCompact ARE supported in Codex despite the public docs).
- [ ] 9.3 After merge, run `/opsx:archive expand-plugin-hooks-coverage`. The archive step SHALL sync the 5 spec deltas into the main specs.
