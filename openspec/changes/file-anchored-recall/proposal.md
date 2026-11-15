## Why

Memories that talk about a file stay invisible while an agent works on that file. Recall fires only at session start, on each prompt (`recall-hints`) and after compaction. Nothing fires when the agent reaches a file mid-turn, and agents rarely call `memory.search` on their own. That is the evidence behind the unarchived `proactive-entity-recall` change. Measured on a production snapshot (2026-11-12), 53% of active memories in a code project carry a `path` entity. Agents in this repository reach about 80% of the files they read through `Bash` (`sed`, `cat`, `grep`, `rtk`…) rather than a file tool. So a decision or known bug about a file is rarely in context at the moment it matters (issue #489).

## What Changes

- **New endpoint** `POST /api/<slug>/sessions/<id>/file-recall`.
  - Input: one repo-relative `path`, plus the repository's tracked paths that share its file name (`siblings`).
  - Output: at most a few short lines about the memories linked to that file, plus an `exhausted` flag that tells the client to stop calling for the rest of the session.
  - **Lookup:** an exact `path` entity lookup on the repo-relative path. A shorter suffix of two or more segments is also tried, but only when no other tracked file shares it.
  - **Which memories:** active `project` / `feedback` / `procedural` memories only, excluding memories saved by the calling session.
  - **Order:** fewest linked paths first (the most specific memory), then newest.
  - **Caps:** at most 3 memories per file and 10 files with output per session.
  - **Format:** each memory gets its title, id, date and a `needs review` marker; only the first also gets a ~300-character window around the file's mention.
  - **Dedupe:** per session by memory id, released when the session is ended, deleted or resumed. Every post-compaction path already resumes.
- **New per-client wiring** that calls the endpoint when the agent reads or edits a file, with the same behaviour on all five clients, in the owner's priority order:
  - **Claude Code:** a `PreToolUse` hook on `Read|Edit|Write|MultiEdit|NotebookEdit|Bash`. Output goes through `hookSpecificOutput.additionalContext`.
  - **Codex CLI:** the same script, through `PreToolUse` on `Bash|apply_patch`. Output is JSON only, with no `permissionDecision`.
  - **Pi:** a `tool_call` handler captures the path, and the note is appended to that call's `tool_result` content.
  - **Hermes Agent:** `transform_tool_result` for file tools and `transform_terminal_output` for terminal commands.
  - **opencode, v2 plugin API only:** `ctx.tool.hook("execute.before")` captures the path, and `ctx.session.hook("context")` injects the note into the next request.
- **Paths from any shell command:** they are extracted with one shared rule, pinned by one cross-language fixture file so the bash, JavaScript and Python extractors agree.
- **Fail open everywhere:** a timeout, a missing endpoint (an older server), a non-repository working directory or a parse failure yields no output, and never blocks or delays a tool beyond the client's bounded budget.
- **Usage counter:** the server counts file-recall firings and the lines served, mirroring the recall counter, so the token cost can be measured in production.
- **Corrected hook manifests:** the Claude Code and Codex manifest requirements now state the true current shape (three `UserPromptSubmit` entries and nine handlers, which the published text still describes as two and eight) plus the new `PreToolUse` entry: seven event types, ten handlers.

## Capabilities

### New Capabilities

- `file-anchored-recall`: the server's behaviour for file-anchored recall. Covers path matching, suffix disambiguation from tracked siblings, type/status/own-session filters, ranking, payload format and byte bound, per-file and per-session caps, per-session dedupe and its release, fail-open semantics and the usage counter.

### Modified Capabilities

- `http-api`: adds the `POST /api/<slug>/sessions/<id>/file-recall` endpoint contract (auth, validation, response shape, failure behaviour).
- `plugin-session-protocol`: adds the cross-client mapping for file recall. Also adds:
  - the shared JavaScript core owns the file-recall call and the shell-path extractor;
  - bash and Python keep their own extractors pinned to one fixture;
  - the client-side path cache, and fail-open budget per client.
- `claude-code-plugin`: the hook-manifest requirement is renamed and rewritten to seven event types and ten handlers, adding the `PreToolUse` file-recall entry and recording the third `UserPromptSubmit` entry (`prompt-hints.sh`) that already ships. A new requirement specifies the `file-recall.sh` hook.
- `codex-distribution`: the hook-configuration requirement is rewritten to seven event types and ten handlers, with `PreToolUse` on `Bash|apply_patch`. A new requirement specifies Codex's JSON-only output and its turn-`cwd` caveat.
- `pi-plugin`: adds the `tool_call` / `tool_result` file-recall requirement.
- `hermes-agent-plugin`: adds the `transform_tool_result` / `transform_terminal_output` file-recall requirement.
- `opencode-plugin`: adds the v2 `execute.before` + `context` file-recall requirement.

## Impact

**Server (no migration, no schema change)**

- `packages/db/src/repositories/entities-repository.ts`: a lookup by a list of path values that returns each memory's linked-path count.
- `packages/core/src/services/agent-sessions.ts`: the file-recall service method and its per-session dedupe state, released on end, soft-delete and resume.
- `packages/core/src/services/usage-counters.ts`: a file-recall counter.
- `apps/web/src/app/api/[slug]/sessions/[id]/file-recall/route.ts` (new) and `apps/web/src/lib/validation.ts` (a `parseFileRecall` validator).
- `apps/web/src/app/api/README.md`.

**Plugins**

- `apps/plugin/hooks/hooks.json` and `apps/plugin/hooks/hooks.codex.json`.
- `apps/plugin/scripts/file-recall.sh` (new) and `apps/plugin/scripts/_api.sh`.
- `apps/plugin/bin/rembric-plugin-core.mjs` and `apps/plugin/bin/rembric-plugin-core.d.mts`.
- `apps/plugin/.pi-plugin/index.ts`, `apps/plugin/.opencode-plugin/plugin.ts` (v2 path only), `apps/plugin/.hermes-plugin/__init__.py`.
- `apps/plugin/test/hook-manifests.test.ts` and a new shared fixture `apps/plugin/test/file-recall-fixtures.json`.

**Docs:** `docs/agents.md`, `apps/plugin/README.md`, the per-client READMEs and `apps/plugin/CHANGELOG.md`.

**Invariants**

- Read-only path: no memory row is written, so append-only and `topic_key` are untouched.
- Scope is resolved at the service layer from the session's project, exactly as `recallHints` does.
- No SQL leaves `packages/db`.
- The new per-session core state in `rembric-plugin-core.mjs` is cleared in `forgetSession`, as `invariants.test.ts` requires.

**Compatibility**

- A plugin that calls an older server gets a 404, which every client treats as "no notes".
- A newer server with an older plugin is unaffected.
- **Not BREAKING:** the hook manifests only gain an event.

**Relationship to open changes**

- This change complements the unarchived `proactive-entity-recall` (prompt-time recall) and does not modify its requirements, which stay unpublished until it is archived.
- It leaves `fix-recall-cold-connection-budget` untouched.
