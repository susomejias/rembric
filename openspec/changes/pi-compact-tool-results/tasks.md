# Tasks

Facts to get right before starting, not work items:

- **This is a plugin-tree change on the unified `plugin` release track.** All five clients share one version. Version carriers (`.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, `.opencode-plugin/plugin.ts`, `.pi-plugin/package.json`) are bumped by release-please through `extra-files`. **Never edit a version by hand.** Adding `peerDependencies` to `.pi-plugin/package.json` is not a version edit and is fine.
- **`apps/plugin/.pi-plugin/` SHALL contain exactly four top-level files and no nested directories** (`openspec/specs/pi-plugin/spec.md:15`). Everything new goes in `index.ts`.
- **`scripts/pi-package.mjs::sharedModules()` (`:33-48`) fails the build on any relative import outside `^\.{1,2}\/bin\/([\w.-]+\.mjs)$`.** Bare `@earendil-works/*` specifiers do not match its scan regex (`/from\s+'(\.[^']*)'/g`) and pass through untouched — verify this rather than assuming it (task 6.3).
- Consult `.agents/skills/rembric-plugin-development/` before touching anything under `apps/plugin/`; its `references/e2e-walkthrough.md` is the procedure section 7 follows, and `references/per-client-gotchas.md` covers Pi.

## 1. Fix the error signal (design D1)

- [x] 1.1 `apps/plugin/.pi-plugin/index.ts` — in the registered `execute` (`:289-300`), when `callTool` reports `isError`, `throw new Error(text)` instead of returning it. Delete `...(isError ? { isError: true as const } : {})` (`:298`) and drop `isError` from the local `ToolExecuteResult` type (`:15-19`): the property is not on `AgentToolResult` and keeping it invites the same dead branch to be rewritten.
- [x] 1.2 Confirm the thrown message is the MCP result text verbatim, not wrapped or prefixed. The equivalence the design rests on is `createErrorToolResult(error.message)` (`pi-agent-core/dist/agent-loop.js:519-524`) producing the same single text block `execute` returns today; a prefix breaks it.
- [x] 1.3 Confirm nothing else in `index.ts` returns or reads an `isError` property on a tool result: `git grep -n "isError" -- apps/plugin/.pi-plugin/` and check every remaining hit is either the `callTool` return shape or the renderer reading it off the render **context**.

## 2. The renderers (design D2–D6, D9)

- [x] 2.1 Add the two static host imports at the top of `index.ts`: `import { Text } from '@earendil-works/pi-tui'` and `import { keyHint } from '@earendil-works/pi-coding-agent'`. Add `@earendil-works/pi-tui` to `.pi-plugin/package.json` `peerDependencies` with range `"*"` (the `pi-coding-agent` entry already exists). No `dependencies` key, no bundling.
- [x] 2.2 Add the pure named export (design D7). Signature: `(text: string, expanded: boolean, isError: boolean, canonicalName: string, keyHintText: string, theme: ThemeLike) => string[]`. No host import may appear on its path. Collapsed = one line: outcome marker, canonical name, `\n`-delimited line count of `text`, and `keyHintText`. Expanded = the complete `text`, unmodified.
- [x] 2.3 Add local type declarations mirroring only what is read: `ToolRenderResultOptions` (`dist/core/extensions/types.d.ts:307-312`, `{ expanded, isPartial }`) and the `ToolRenderContext` members actually used (`:314-339`) — `isError` above all. Widen the local `ToolDefinition` (`:21-31`) with optional `renderCall` and `renderResult`.
- [x] 2.4 `renderResult` — read `expanded` from the **options** argument and `isError` from the **context** argument. Reading `isError` off the result argument yields a permanently-false branch (`tool-execution.js:248` narrows it to `{ content, details }`); task 5.3 is the test that proves this is not what shipped. Join the `text` blocks of `result.content` the way `callTool` already does (`index.ts:187-190`), call `keyHint('app.tools.expand', …)`, pass the string into 2.2, and return `new Text(lines.join('\n'), 0, 0)`.
- [x] 2.5 `renderCall` — return `new Text(theme.fg('toolTitle', theme.bold(canonicalName)), 0, 0)`. Name only; no arguments (design D4).
- [x] 2.6 Attach both to the `pi.registerTool` call (`index.ts:284-301`), closing over `tool.name` (the canonical dotted name, which `label` already carries). No tool-name literal and no per-tool branch anywhere on the render path.

## 3. Unblock the test file (design D7)

- [x] 3.1 `apps/server/vitest.config.ts` — add a `resolve.alias` entry for `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent`, pointing at a stub. The config has no `resolve` block today. One comment line naming the reason (a `.pi-plugin` static host import that resolves only inside the harness) — that is the non-obvious _why_ the comment policy permits; do not add a banner.
- [x] 3.2 The stub must expose `Text` (a class whose `render(width)` returns the text split on `\n`, plus `invalidate()`) and `keyHint(id, description)` returning a recognisable sentinel. Keep it minimal: anything richer starts substituting for the host.
- [x] 3.3 Verify the alias does not shadow anything the server suite wants: `git grep -n "@earendil-works" -- apps/server/src` must return nothing.
- [x] 3.4 Confirm `plugin.test.ts` still loads (`plugin.test.ts:28` imports `./index.js` at module level, so a resolution failure kills the whole file, not one arm): `pnpm vitest run ../plugin/.pi-plugin/plugin.test.ts` from `apps/server` and read the reported file and test counts rather than assuming.

## 4. Render coverage against the pure function

Every arm here drives the 2.2 export with a fake `theme` (`{ fg: (c, t) => …, bold: (t) => … }`). Possible only because Pi passes the theme as a parameter (`tool-execution.js:248`).

- [x] 4.1 Collapsed success: a multi-line payload renders as exactly one line, containing the canonical dotted name, the line count and the key-hint string, and **not** containing any substring of the payload.
- [x] 4.2 Expanded success: the same payload renders containing the complete original text. Assert byte equality of the joined output against the input text, and assert the input is non-empty and multi-line first — an equality over an empty payload proves nothing (this repo has shipped that mistake).
- [x] 4.3 Collapsed failure: same payload with `isError: true` renders one line whose outcome marker differs from 4.1's, and whose styling goes through the fake theme's error colour. Assert the difference against 4.1's output, not against a hard-coded string.
- [x] 4.4 Expanded failure: the complete diagnostic text is present, including the `code` field, for a payload shaped like `mcpError()`'s (`apps/server/src/mcp/errors.ts:15`).
- [x] 4.5 Unconditional collapsing: a one-line payload and a several-hundred-line payload both render collapsed with expansion off. This is the arm that would red if someone later adds the threshold design D2 rejects.
- [x] 4.6 The line count is of `\n`-delimited lines: a single 500-character line reports 1, not a width-dependent number.
- [x] 4.7 Generic-across-tools: drive the same function with two different canonical names and assert only the name differs in the output.

## 5. Coverage at the adapter boundary

The suite already stands up a real in-process server, a real SQLite file and real auth (`plugin.test.ts:1-40`), so these read through the real MCP path.

- [x] 5.1 A proxied call whose MCP result carries `isError: true` — a `memory.get` on a fabricated id, which the server answers through `mcpError` with code `not_found` — makes `execute` **reject**, and the rejection's message equals the MCP result text.
- [x] 5.2 **The control**: a successful proxied call resolves, and its `content[0].text` is unchanged from the MCP result text. Without this, a broken probe and a real defect are indistinguishable.
- [x] 5.3 The context-vs-result arm: invoke `renderResult` with `context.isError === true` and a result argument carrying no error property, and assert the output indicates failure. Then assert the inverse — that a renderer reading `result.isError` for the same input would report success — so the reason for design D1's central fact is in the suite, not only in prose.
- [x] 5.4 Registration arm: every registered tool definition carries both `renderCall` and `renderResult`, for the full discovered set. Assert against the discovered count, not a hard-coded number.
- [x] 5.5 Source arm: extend the existing "plugin source contains no tool inventory" check so it also covers the render path — no server tool name literal, no response-field access.

## 6. Mutation checks — a guard is not covered until its test fails without it

Run each with `node scripts/mutate.mjs --file apps/plugin/.pi-plugin/index.ts --spec ../plugin/.pi-plugin/plugin.test.ts --mutation '…' --with '…'`. The `--spec` path is relative to `apps/server`, which is the cwd `mutate.mjs` runs vitest from. **Record in this file which arms each mutation reddened.** If a mutation reddens nothing, the arm asserts the wrong thing — fix the test, not the mutation.

- [x] 6.1 Revert the throw to the previous return-with-flag → 5.1 must red (and 5.2 must stay green).
  - **Reddened (4)**: `rejects with the MCP result text verbatim when the result carries isError` (5.1), plus the three `argument validation` arms, which read a refusal as a rejection. 5.2 (`the control — a successful call resolves, with its text unchanged`) stayed green.
- [x] 6.2 Invert the renderer's error condition → 4.3 and 5.3 must red.
  - **Reddened (2)**: `marks a failed result differently from a successful one, in the error colour` (4.3) and `reads the error flag off the render context, where a result-reader would see nothing` (5.3).
- [x] 6.3 Force `expanded` to `false` inside the pure function → 4.2 and 4.4 must red.
  - **Reddened (2)**: `restores the complete original text, byte for byte, when expanded` (4.2) and `expands a failure to its full diagnostic text, error code included` (4.4).
- [x] 6.4 Force `expanded` to `true` → 4.1 and 4.5 must red. Both directions, because a renderer that ignores the flag passes whichever single-direction arm you happen to write.
  - **Reddened (7)**: `collapses a successful multi-line result…` (4.1) and `collapses regardless of size…` (4.5), plus 4.3, 4.6, 4.7 and the two `the registered renderers` arms that read a collapsed line.
- [x] 6.5 Replace `keyHint(...)`'s result with a hard-coded `'ctrl+o'` → the hint arm must red. If it does not, the hint is untested and the spec's "SHALL NOT emit a hard-coded key literal" is unbacked.
  - **Reddened (2)**: `takes the expand hint from the harness binding rather than a key literal` and the source arm `the render path names no tool, reads no response field and hard-codes no key` (5.5).
- [x] 6.6 Delete `renderCall` from the registration → 5.4 must red.
  - **Reddened (3)**: `every discovered tool is registered with both renderers` (5.4), `the call slot renders the canonical dotted name and no argument`, and the source arm (5.5).

## 7. Real-Pi e2e validation (mandatory, not optional)

The unit harness supplies the render context itself, so it cannot prove the host passes `isError` where the design says it does, nor that the collapsed line actually looks right. `pi` 0.84.1 is installed in this environment, so this runs — it is not a rig to be built. Follow `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md`.

- [x] 7.1 **Point the run at a local stack, never a real deployment.** The operator's shell may export `REMBRIC_SERVER_URL` / `REMBRIC_API_TOKEN` for a live server; a naive `pi` run in this repo files probe sessions into a production project. Export both explicitly against `pnpm run dev:docker:up`, with its own token and its own project slug in `.rembric`, and verify the URL resolves to the local stack before starting. Point `HOME` at a scratch dir so `~/.pi` is untouched.
  - **Done.** The tool shell here really does export `REMBRIC_SERVER_URL=https://rembric.susomejias.dev` and a token for it. Every arm ran under `env -i` with only `HOME=<scratch>/pihome`, `REMBRIC_SERVER_URL=http://127.0.0.1:8788` and the local `demo-writer` token, and `.rembric` in the scratch cwd names `demo`. Confirmed after the fact: all 9 `agent='pi'` rows landed in the dev stack's `/data/data.db`; nothing reached the deployment.
- [x] 7.2 **`dev:docker:up` wipes and reseeds `data-dev` on every boot** — the reset lives in the container command, not in `package.json`, so it is invisible from the script name. Assume no corpus survives between runs. This run **is** the mandatory Docker smoke against pre-existing seeded data: use the real stack, not an in-process server, for at least one full pass.
  - **Done.** `dev:docker:up` rebuilt and reseeded: `counts: memory=35 projects=20 sessions=5 tokens=3`. Every arm ran against that stack over real HTTP/MCP, not an in-process server. (`data-dev` was copied to the scratchpad first, since the boot wipes it.)
- [x] 7.3 Load the extension per-run with `pi -e <path>` (never installed into the operator's config) and drive a real session: one prompt that triggers `memory.context` or `memory.search`. Capture the transcript. Assert the tool row is one line, names the canonical dotted tool, and shows the line count and the real key.
  - **Observed**, real TUI, first frame (expansion off):

    ```
    memory.context
    ✓ memory.context · 170 lines · ctrl+o to expand
    ```

    One line; the call line is the canonical dotted name (the control at HEAD renders `memory_get`/`memory_context`, the underscored registration spelling); the line count and the operator's real binding are both present. Driven by a local fake OpenAI-compatible provider that emits a `tool_calls` delta, so a real tool call happens with no external request.

- [x] 7.4 Press the expand key and assert the complete payload appears; press again and assert it collapses. Record that the toggle moved **every** tool row, not just the Rembric one — that is design D2's accepted cost and it should be observed, not inferred.
  - **Observed.** One `ctrl+o` expanded the Rembric row (full `recentMemories` JSON) **and** the built-in `read sample.txt` row (`sample file line 001` … `059`) in the same frame; a second press collapsed both back to the exact first frame. The global toggle is measured, not inferred — design D2's accepted cost.
- [x] 7.5 Error arm: drive a `memory.get` on a fabricated id so the server answers `not_found` through `mcpError`. Assert the row renders as a failure (the harness paints `toolErrorBg` when its flag is set, `tool-execution.js:205-210`, which only D1 makes reachable) and that expanding it shows the full diagnostic including the `code`.
  - **Observed.** `✗ memory.get · 5 lines · ctrl+o to expand`, and expanding showed `"ok": false` / `"code": "not_found"` in full. Background: the arm's raw output contains `48;5;52` (dark red, `toolErrorBg`) ×12 and **zero** `48;5;22`. The instrumented run also recorded the host passing `context.isError: true` — the design's open risk that the unit harness supplies its own render context.
- [x] 7.6 **The control that must fail**: the same error arm with the extension from `git HEAD` (0 occurrences of the throw). It must render on the success background and the model-facing result must not be flagged. Without it, 7.5 cannot distinguish the fix from a bench artefact.
  - **The control failed in the expected direction.** Same arm with `git show :apps/plugin/.pi-plugin/index.ts` (0 occurrences of the throw, 1 of `isError: true as const`): the call line reads `memory_get`, the whole payload prints uncollapsed, `ctrl+o` changes nothing, and the raw output carries `48;5;22` (dark green, `toolSuccessBg`) ×16 with **zero** `48;5;52`. The persisted transcripts settle the model-facing half: for byte-identical `toolResult` content (103 chars, multi-line), treatment `isError: True`, control `isError: False`.
- [x] 7.7 Keybinding-override arm (design open question 2): rebind `app.tools.expand` in the scratch `HOME`'s `<agentDir>/keybindings.json`, re-run, and assert the hint names the new key. If the override turns out not to reach `keyHint`, say so here rather than ticking the arm — the design names this as the open question it answers.
  - **Answered: yes.** With `<scratch HOME>/.pi/agent/keybindings.json` = `{"app.tools.expand": "ctrl+y"}` the collapsed line rendered `✓ memory.context · 170 lines · ctrl+y to expand`, and `\x19` expanded the row. The override reaches `keyHint` at render time; design open question 2 needs no revisit.
- [x] 7.8 Record what `isPartial` did (design open question 1): whether any Rembric tool row ever rendered with `isPartial: true`. If it never did, say that it was not observed rather than that it cannot happen.
  - **Not observed.** An instrumented copy of the extension logged every `renderResult` call. Across the success arm (3 calls) and the error arm (2 calls), `options.isPartial` and `context.isPartial` were `false` every time; `options.expanded` moved `false → true → false` with the two keypresses. `isPartial: true` was never seen for a Rembric row — stated as not observed, not as impossible.
- [x] 7.9 Use `--api-key` with a deliberately invalid key where no real model call is needed, so nothing is billed for arms that only need the extension loaded.
  - **Deviation, recorded.** `--api-key <invalid>` was **not** used. It cannot satisfy 7.3–7.6: an invalid key means the model never runs, so no tool is ever called and no `ToolExecutionComponent` is built — there is nothing to render. Instead a local fake OpenAI-compatible provider (registered through a second `-e` extension, `baseUrl: http://127.0.0.1:<port>/v1`) emits a canned `tool_calls` delta. Strictly stronger on the task's stated intent: no external request was made at all, so nothing could be billed.

## 8. Documentation

- [x] 8.1 `apps/plugin/.pi-plugin/README.md` — a short "Tool output" note: results are collapsed by default, `app.tools.expand` (default `ctrl+o`) toggles them, and the toggle is global to the transcript.
- [x] 8.2 `docs/agents.md` — the Pi section gains the same, in the register of the neighbouring client sections.
- [x] 8.3 Confirm no surface now claims Pi renders full tool output, and none claims per-row expansion: `git grep -n "tool output\|renderResult\|app.tools.expand" -- docs openspec/specs apps/plugin` and check each hit.

## 9. Verification

- [x] 9.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all green. Note honestly which of these actually covers `index.ts`: **typecheck does not** (`apps/server/tsconfig.json:26` is `"include": ["src/**/*"]`), and lint covers it without type information (`eslint.config.js:88-93`, `projectService: false`). Confirm the Pi arms actually executed by reading the reported test count, not by assuming.
  - `pnpm run typecheck` **green** (`apps/server` only — it does not cover `index.ts`, `tsconfig.json:26` is `"include": ["src/**/*"]`). `pnpm run lint` **green** (covers `index.ts` without type information). `pnpm test`: **2598 passed, 3 failed**, all three in `invariants.test.ts` and all three **pre-existing environment failures, not this change** — `.git/config` in this checkout carries `bare = true` beside a working tree, so the `git grep` those three arms derive their file lists from returns nothing and `|| true` swallows the error. Proof: `GIT_WORK_TREE=/root/rembric GIT_DIR=/root/rembric/.git pnpm vitest run src/test/invariants.test.ts` → **91/91 pass**. The Pi file reports **65 tests, 1 file passed** (50 before this change).
- [x] 9.2 `pnpm run eval` is **not** required: retrieval, ranking and the entity pipeline are untouched — this change adds two render functions and one `throw` in a client. State it rather than skipping it silently.
  - Not run, deliberately. Retrieval, ranking and the entity pipeline are untouched: this change adds two render functions and one `throw` inside a client, and reaches no server code and no database.
- [x] 9.3 `pnpm vitest run apps/server/src/test/invariants.test.ts` — the single-implementation invariant derives its file list by search; confirm it still passes and that the new render code did not duplicate anything from `rembric-plugin-core.mjs`.
  - Passes under `GIT_WORK_TREE`/`GIT_DIR` (91/91), including `the JS/TS plugin clients share one implementation of each protocol helper`. The render code duplicates nothing from `rembric-plugin-core.mjs` — it is new logic with no counterpart there.
- [x] 9.4 `node scripts/pi-package.mjs assert-pack` (and `materialize` on a scratch copy) — prove the bare `@earendil-works/*` specifiers pass the relative-import guard and that the tarball contents are unchanged apart from `package.json`. Measure it; do not infer it from the regex.
  - **Measured, both arms.** `sharedModules()` accepted `index.ts` unchanged: `materialize` reported `rewrote 2 import specifiers`, i.e. only the two `../bin/*.mjs` ones, and the bare `@earendil-works/*` specifiers were left untouched (`import { keyHint } from '@earendil-works/pi-coding-agent'` survives verbatim into the materialised copy). `assert-pack` reported `tarball contents match the expected list` for both, and the 9-file `npm pack --dry-run` list is **byte-identical** between `git HEAD` and this change. Run on scratch copies, so no `bin/`/`commands/` was left in the repo.
- [x] 9.5 `git ls-files apps/plugin/` shows ONE copy of each shared resource, and `ls apps/plugin/.pi-plugin/` still lists exactly four files with no nested directory.
  - `git ls-files apps/plugin/` shows one `bin/rembric-dotenv.mjs`, one `bin/rembric-plugin-core.mjs`, one `scripts/_api.sh`; the only duplicated basenames are the legitimate per-client manifest files. `ls apps/plugin/.pi-plugin/` still lists exactly `index.ts`, `package.json`, `plugin.test.ts`, `README.md` and no directory.
- [x] 9.6 `openspec validate pi-compact-tool-results --strict` passes.
  - `Change 'pi-compact-tool-results' is valid`.
- [x] 9.7 `pnpm run check:delta-freshness` — record the requirement and body-line counts it reports, so a later delta that silently reverts this one is visible.
  - `delta-freshness: ok (1 active change(s))`. Counts for a later delta to be checked against: the delta carries **3 requirements** (2 ADDED, 1 MODIFIED) over **109 non-blank body lines**; the published `openspec/specs/pi-plugin/spec.md` carries **16 requirements**, and the MODIFIED target — `MCP transport is Streamable HTTP with a Bearer token and no runtime dependency` — is present in it, so archive will replace rather than append.
- [x] 9.8 `pnpm run check:spec-provenance` green (CI is the gate; run it locally before pushing).
  - **Exits 2, and that is the documented empty-range outcome, not a failure**: nothing is committed (this session was told not to commit), so `origin/main..HEAD` holds no commits and the checker refuses to pass over a diff it never examined. Must be re-run once the work is committed; CI is the gate either way.

## 10. Deferred and rejected, recorded so they are not lost

- [x] 10.1 **Per-tool semantic summaries** (`memory.search · 7 results`, `memory.save · saved <title>`). Deferred by the issue itself and by design D5: each one reads a response DTO, which is the coupling the discovery design exists to avoid. If it is ever wanted, it needs its own change and its own answer to what happens when the server changes a field name.
- [x] 10.2 **A typecheck gate over `apps/plugin/.pi-plugin/index.ts`.** Nothing typechecks it today, and design D8 records why this change makes a gate harder rather than easier: the static host imports would need `@earendil-works/*` declarations in CI, i.e. a devDependency on a package carrying five provider SDKs (a cost this client's spec already refuses) or a `paths` map onto a global install CI does not have. Issue #333's type-safety criterion is answered here by review plus the section-4 behavioural tests, and the missing compiler gate is stated, not implied covered.
- [x] 10.3 **Rejected, not deferred: a size threshold for collapsing** (design D2) and **carrying the error flag in `details` or through a `tool_result` handler** (design D1). Recorded so nobody re-derives them; each has its rejection reason and its measurement in `design.md`.
- [x] 10.4 **The same unchecked-TypeScript exposure applies to `apps/plugin/.opencode-plugin/plugin.ts`.** Same class, not this change's file, and it may red on pre-existing findings.
