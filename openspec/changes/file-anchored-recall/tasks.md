## 1. OpenSpec change (PR 1)

- [x] 1.1 Write proposal, design, delta specs and tasks under `openspec/changes/file-anchored-recall/`
- [x] 1.2 `openspec validate file-anchored-recall --strict` passes, and `pnpm run check:delta-freshness`, `check:delta-sections` and `check:spec-crossrefs` report no failure for this change

## 2. Server: lookup, service, route (PR 2)

- [ ] 2.1 Add a repository method in `packages/db/src/repositories/entities-repository.ts`. It finds active memories of the given types linked to any of a list of `path` values in one scope, excluding a session id, and returns each memory's linked-path count, ordered by count asc, `created_at` desc, `id` desc. Co-located test covers ordering, the type/status/session filters, and a multi-value match that returns a memory once.
- [ ] 2.2 Add `fileRecall(sessionId, path, siblings)` to `AgentSessionsService`. It covers:
  - normalisation and repo-relative check;
  - unique-suffix candidates from `siblings`;
  - per-file and per-session caps, `exhausted`, and the per-memory-id dedupe LRU (500 sessions), released on `end`, `softDelete` and `resume`;
  - rendering: header, `- <title> [<id>] (<date>[, needs review])`, a window only on the first memory, secret redaction before the cut, and the 1024-byte bound.
- [ ] 2.3 Add the file-recall counter to `usage-counters.ts`.
- [ ] 2.4 Write tests for every scenario of `specs/file-anchored-recall/spec.md`, through the service's public method:
  - exact and unique-suffix match, and the shared-suffix refusal with its control;
  - ineligible memories with their control;
  - specificity order, window placement, byte bound with multibyte text, and the `needs review` marker;
  - dedupe across files, the cap and `exhausted`, release on resume;
  - `last_seen_at` untouched.
- [ ] 2.5 Add `parseFileRecall` to `apps/web/src/lib/validation.ts` (path ≤1024, siblings ≤64×≤1024, unknown keys ignored) and the route `apps/web/src/app/api/[slug]/sessions/[id]/file-recall/route.ts`, mirroring `recall-hints` (auth, `project_not_found`, read authorisation, soft-deleted refusal, POST only). Document it in `apps/web/src/app/api/README.md`.
- [ ] 2.6 Add route tests in `apps/web/src/test/api-router.test.ts` for every scenario of `specs/http-api/spec.md` (200 shape, invalid bodies with the unknown-key control, 403 with its control, method fallback).
- [ ] 2.7 Mutation-check every new guard with `node scripts/mutate.mjs` (with `--workspace packages/core` for the service), weakening each condition separately: suffix uniqueness, own-session exclusion, type filter, status filter, per-file cap, session cap, dedupe, the byte bound and the release on resume. Each mutation must turn a named test red.
- [ ] 2.8 Run `pnpm run typecheck`, `pnpm run lint` and `pnpm test` green.
- [ ] 2.9 Smoke against the local dev server (`pnpm run dev`): save a memory naming a file, then POST file-recall for it and for a suffix with and without siblings. Record the responses in the PR.

## 3. Claude Code and Codex (PR 3)

- [ ] 3.1 Add to `apps/plugin/test/file-recall-fixtures.json` shell commands with their expected path lists. Include `cat`, `sed -n`, `grep`, `rg -n`, `git show HEAD:<p>`, `rtk read <p>`, quoted paths, absolute paths, `../` paths, a command naming no path, a command naming more than 5 paths, and Codex `apply_patch` texts with Add/Update/Delete lines.
- [ ] 3.2 Add the path extractor, apply_patch parser, repo-relative normaliser, siblings lister and per-session record (lock directory, line-at-a-time append) to `apps/plugin/scripts/_api.sh`, with a test that runs the extractor over every fixture.
- [ ] 3.3 Add `apps/plugin/scripts/file-recall.sh <agent>`:
  - Claude Code input: `tool_input.file_path`, `notebook_path` or `command`. Codex input: `command` for `Bash` and `apply_patch`.
  - Skips sub-agent calls (`agent_id` present).
  - POSTs with `REMBRIC_POST_MAX_TIME=0.3`.
  - Prints JSON `hookSpecificOutput.additionalContext` only, never `permissionDecision`, and stops after `exhausted`.
  - Runs `trap 'exit 0' ERR` and exits 0 everywhere.
- [ ] 3.4 Add the `PreToolUse` entry to `apps/plugin/hooks/hooks.json` (matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Bash`, env from plugin options, `timeout: 2`, no `async`) and to `apps/plugin/hooks/hooks.codex.json` (matcher `Bash|apply_patch`, `timeout: 2`).
- [ ] 3.5 Update `apps/plugin/test/hook-manifests.test.ts`:
  - seven events and ten handlers on both manifests;
  - the exact ordered invocations, including `file-recall.sh claude-code` and `file-recall.sh codex-cli`;
  - assertions pinning both `PreToolUse` matchers;
  - the existing no-`*.codex.sh` check still passes.
- [ ] 3.6 Add script tests driven through the real script with a stub server:
  - a Bash read is injected once, and the second read issues no request;
  - Read, Edit and NotebookEdit inputs;
  - Codex apply_patch, with Codex output that is JSON or nothing;
  - 404, timeout and non-git cwd stay silent with exit 0;
  - `agent_id` is skipped;
  - eight concurrent firings leave an untorn record.
    Then mutation-check the sub-agent skip, the once-per-file record, the `exhausted` stop and the no-`permissionDecision` rule.
- [ ] 3.7 Run e2e against the dev server for Claude Code, using the isolated variant where it applies (`references/e2e-walkthrough.md`): a real session reads a file linked to a memory, and the note appears in context once. Note in the PR what can and cannot be driven.
- [ ] 3.8 Run e2e for Codex CLI the same way. If the interactive hook trust gate blocks it, say so and list the manual steps. **(may need operator)**
- [ ] 3.9 Docs: `docs/agents.md`, `apps/plugin/README.md`, `apps/plugin/CHANGELOG.md` via the conventional commit.
- [ ] 3.10 Get an independent verification of the PR before delivery, for the concurrent per-session record (high-risk item 4).

## 4. Pi (PR 4)

- [ ] 4.1 Add `extractCommandPaths`, `fileRecall` and the per-session sent/exhausted record to `apps/plugin/bin/rembric-plugin-core.mjs`, typed in `rembric-plugin-core.d.mts` and cleared in `forgetSession`. Add a test running `extractCommandPaths` over every fixture.
- [ ] 4.2 In `apps/plugin/.pi-plugin/index.ts`:
  - a guarded `tool_call` handler captures paths (read/edit/write `input.path`, bash `input.command`), resolves them against `ctx.cwd`, lists siblings and calls `fileRecall` keyed by `toolCallId`;
  - a `tool_result` handler appends the text block and returns `structuredContent` unchanged.
- [ ] 4.3 Add tests in `.pi-plugin/plugin.test.ts`: annotation with `structuredContent` preserved; the timeout control with the result unchanged and no throw or `block`; once per file; sub-agent sessions skipped.
- [ ] 4.4 Run e2e in an isolated Pi run against the dev server.
- [ ] 4.5 Docs: the Pi README and the CHANGELOG.

## 5. Hermes (PR 5)

- [ ] 5.1 **Spike:** against the installed Hermes, record the result shape of `read_file`, `write_file`/`patch` and `terminal` as seen by `transform_tool_result` and `transform_terminal_output`. Decide the JSON-preserving append form. Record it as `<!-- spike result: … -->` here and as a comment in `__init__.py`.
- [ ] 5.2 Add a Python extractor agreeing with `file-recall-fixtures.json` (a test runs every fixture); store `initialize()`'s `cwd`; add the file-recall POST with a 0.5 s budget and the per-session record.
- [ ] 5.3 Register `transform_tool_result` (file tools) and `transform_terminal_output` (terminal) from `register(ctx)`. Return the annotated result or `None`, catching every exception.
- [ ] 5.4 Add pytest coverage in `.hermes-plugin/tests/`: annotation, the unreachable-server control returning a byte-identical result, once per file, and the terminal path.
- [ ] 5.5 Run e2e in a real Hermes session against the dev server, using the "Driving a real Hermes" rails.
- [ ] 5.6 Docs: the Hermes README and the CHANGELOG.

## 6. opencode v2 (PR 6)

- [ ] 6.1 In `apps/plugin/.opencode-plugin/plugin.ts`, v2 path only:
  - widen the `execute.before` input type to `tool`, `sessionID`, `input`;
  - capture paths, list siblings and await `fileRecall` within budget, never throwing;
  - queue lines per session, and push them in the existing `context` hook, then clear.
- [ ] 6.2 Add tests in `.opencode-plugin/plugin.test.ts`: one push on the next context then none; sub-agent sessions skipped; the v1 export registers no tool hook.
- [ ] 6.3 Run e2e in an opencode v2 session against the dev server. **(may need operator: requires an opencode ≥ 2.x install)**
- [ ] 6.4 Docs: the opencode README and the CHANGELOG.

## 7. Close

- [ ] 7.1 After PRs 2–6 merge, run `openspec archive file-anchored-recall` in a follow-up commit and confirm `pnpm run check:spec-provenance` passes.
- [ ] 7.2 Operator, after release: read the file-recall counter for two weeks and confirm median tokens per session below about 300 and hook p95 below 50 ms. Otherwise open a follow-up change to adjust the caps. **(operator)**
