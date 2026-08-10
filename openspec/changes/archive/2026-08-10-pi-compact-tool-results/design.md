## Context

Everything below was measured against `@earendil-works/pi-coding-agent@0.84.1` as installed on the development machine (`/root/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent`). Note the package was renamed from `@mariozechner/*`, which is what issue #333's documentation links still point at; the alias map at `dist/core/extensions/loader.js:89-110` still carries both spellings.

Four host facts constrain every decision here.

**The renderer path is already taken; only the renderers are missing.** `hasRendererDefinition()` is `this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined` (`dist/modes/interactive/components/tool-execution.js:75-77`), true for every extension-registered tool. So today's transcript is `createCallFallback()` (`:106-108`) plus `createResultFallback()` (`:109-115`) — the underscored registration name, then the whole payload. Defining `renderResult` alone is legal and changes only the result line; the call line keeps falling back.

**`isError` never reaches the renderer's first argument, and today it never reaches the host at all.** `updateDisplay()` calls the renderer with a narrowed `{ content: this.result.content, details: this.result.details }` (`:248`); the flag is on the fourth argument, `getRenderContext()`'s `isError: this.result?.isError ?? false` (`:103`). And that `this.result.isError` is itself set by the host, not by the tool: `component.updateResult({ ...event.result, isError: event.isError })` (`dist/modes/interactive/interactive-mode.js:2641`) spreads the host's flag **last**, `AgentToolResult` (`@earendil-works/pi-agent-core/dist/types.d.ts:316-330`) has no `isError` member, and `executePreparedToolCall` hardcodes `return { result, isError: false };` on the success path (`pi-agent-core/dist/agent-loop.js:470`). So `apps/plugin/.pi-plugin/index.ts:298` — `...(isError ? { isError: true as const } : {})` — is dead code and always has been.

**Expansion is global, not per row.** `interactive-mode.js:262` declares one `toolOutputExpanded = false;`; `toggleToolOutputExpansion()` (`:3305-3307`) calls `setToolsExpanded()` (`:3308-3324`), which walks `loadedResourcesContainer` and `chatContainer` and calls `setExpanded(expanded)` on every expandable child. No design here can promise per-row expansion, and the spec must not imply it.

**A renderer that throws degrades to today's behaviour for free.** Both renderer calls are wrapped in `try/catch` with the fallback in the `catch` (`tool-execution.js:231-234` for the call slot, `:253-262` for the result slot), and `docs/extensions.md:2327-2330` states it: "If a slot renderer is not defined or throws: `renderCall`: Shows the tool name; `renderResult`: Shows raw text from `content`." So no host-version guard is needed in the adapter.

The repo's own gates are shallower than they look and this design has to work inside them. `apps/plugin/.pi-plugin/plugin.test.ts` **is** run (`apps/server/vitest.config.ts:14` includes `'../plugin/.*-plugin/*.test.ts'`) and imports `rembric from './index.js'` at module level (`plugin.test.ts:28`). But `.pi-plugin/index.ts` is typechecked by **nothing** — `apps/server/tsconfig.json:26` is `"include": ["src/**/*"]` and root `typecheck` is `pnpm -r run typecheck` — and ESLint lints it with `parserOptions: { projectService: false }` (`eslint.config.js:88-93`), so no type-aware rule fires on it either.

## Goals / Non-Goals

**Goals:**

- Make a Rembric tool result one line in Pi's transcript by default, and `app.tools.expand` restore the complete original text.
- Make a failed tool call visibly failed — to the operator and to the model — which requires fixing the dead flag, not just rendering around it.
- Keep the renderer as blind to response shapes as the registration already is, so adding or renaming a server tool still needs no plugin change.
- Keep the render logic drivable by a unit test that does not depend on any stub of a host package.

**Non-Goals:**

- Any server change. No new MCP tool, no schema edit, no migration, no SQL.
- Per-tool semantic summaries (`memory.search · 7 results`). That is the schema coupling the discovery design exists to avoid, and the issue names it as a separate follow-up.
- Per-row expansion. The host does not offer it (Context).
- Print mode. It builds no `ToolExecutionComponent`.
- A typecheck gate over `index.ts` (D8 records why this change makes one harder, not easier).

## Decisions

### D1 — `execute` throws on an MCP error result; the phantom `isError` property is deleted

When `callTool` reports `isError`, the adapter throws `new Error(text)` rather than returning `{ ..., isError: true }`.

This is the harness's documented contract, quoted verbatim from `docs/extensions.md:1984`:

> **Signaling errors:** To mark a tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an error from `execute`. Returning a value never sets the error flag regardless of what properties you include in the return object.

**Why it is safe for the model.** Pi's catch produces `createErrorToolResult(error.message)`, which is (`pi-agent-core/dist/agent-loop.js:519-524`):

```js
function createErrorToolResult(message) {
  return {
    content: [{ type: 'text', text: message }],
    details: {},
  };
}
```

The adapter today returns (`apps/plugin/.pi-plugin/index.ts:295-299`) `{ content: [{ type: 'text', text }], details: undefined, ...(isError ? { isError: true } : {}) }`. Throwing `new Error(text)` makes `message === text`, so `content` is the identical single text block. `details` moves `undefined` → `{}`, which the provider payload does not carry. What changes is `toolResult.isError` (`agent-loop.js:534-547`, `isError: finalized.isError`) going `false` → `true`, which for Anthropic becomes a wire field: `@earendil-works/pi-ai/dist/api/anthropic-messages.js:829`, `is_error: msg.isError`. **That is the fix, not a side effect** — the model has been receiving Rembric's `not_found` and `scope_locked` responses as successes.

**This change discovered the defect; it did not inherit it.** Issue #333 scopes itself to presentation, but its own error criterion cannot be met without this, because `context.isError` — the only flag a renderer can read — is fed by exactly the value being hardcoded to `false`. An error branch fed by it would be dead code sitting behind a spec requirement, which is the "claim behaviour nobody will implement" failure mode. The user approved widening the scope for this reason.

**Alternative rejected: carry the flag in `details` and read it in the renderer.** Renders red, but leaves the model told the call succeeded. It converts a real defect into a cosmetic patch and would make the spec text false in the part that matters most.

**Alternative rejected: a `tool_result` extension handler returning `{ isError: true }`.** This genuinely works — `agent-session.js:244-270` installs `agent.afterToolCall`, `runner.emitToolResult` (`extensions/runner.js:651-699`) accepts `isError` from a handler, and `finalizeExecutedToolCall` applies it (`agent-loop.js:505`, `isError = afterResult.isError ?? isError`). Rejected on cost: the handler cannot see the MCP flag, so `execute` would have to plant a marker in `details` for it to read, giving two coupled moving parts plus a global handler that must filter by registered tool name — all to reach the state one `throw` reaches, while writing an extension-private marker into session history.

**Consequence for transport failures: none.** `send()` already throws on a non-2xx (`index.ts:126-128`) and on a JSON-RPC `error` member (`:132-135`), so those already flag correctly today. D1 brings application-level MCP errors onto the same path — it does not create it.

### D2 — Collapse every discovered tool, always; no size threshold

Every tool returned by `tools/list` renders collapsed by default. There is no line-count or byte-count condition under which a result renders expanded.

The honest cost, recorded rather than hidden: a two-line result loses nothing by being shown whole, so collapsing it is pure ceremony — and because expansion is global (Context), an operator who wants that one line back expands the entire transcript. Accepted for predictability. A threshold makes the operator's model of the UI "sometimes collapsed, depending on a number they cannot see", and it puts a tuning constant into a client that has deliberately avoided knowing anything about payload shapes.

**Alternative rejected: collapse only above N lines.** Cheaper on paper, and it is what makes the behaviour unpredictable in practice; it also invites the follow-on question of which N, per tool, which is the coupling D5 forbids.

### D3 — The collapsed line carries a line count — a signal, not a gate

`memory.context · 148 lines` rather than `memory.context · result available`. This is not D2's rejected threshold: nothing branches on the number, it is only displayed.

It is worth the two characters of code because `JSON.stringify(payload, null, 2)` (`apps/server/src/mcp/result.ts:7`) makes line count a real measure of how much the operator is being spared — a `memory.get` and a `memory.context` differ by two orders of magnitude — and it is the exact convention Pi's own built-ins use: `dist/core/tools/ls.js:43`, `grep.js:58`, `read.js:118` and `find.js:61` all render `... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`.

The count is of `\n`-delimited lines in the payload, **not** of rendered terminal rows. Rendered rows depend on the viewport width (`Text.render(width)` word-wraps), so a width-dependent number would change under a resize while describing a payload that did not. This matches what the built-ins count.

**Alternative rejected: `result available`** (the issue's own sketch) — identical cost, strictly less information. **Alternative rejected: line count and byte count** — two numbers answering the same question.

### D4 — A minimal `renderCall` renders the canonical dotted name

Without a `renderCall` the call line is `createCallFallback()` (`tool-execution.js:106-108`), `theme.fg("toolTitle", theme.bold(this.toolName))`, where `toolName` is the name the tool was **registered** under. Registration underscores (`index.ts:285`, `name: tool.name.replace(/\./g, '_')`) because a real provider rejects the entire tools payload over one `.` — the `pi-plugin` capability's "Tools are registered under provider-safe names" requirement records the measurement. `label` carries the canonical name, and the fallback does not read `label`.

So the operator currently reads `memory_context`, a spelling that exists only to satisfy a provider's regex. A `renderCall` that renders the canonical dotted name costs one function and fixes it.

It renders the name and nothing else. Rendering arguments would mean deciding which argument matters for each tool, which is per-tool knowledge; and `memory.save`'s `content` argument would reintroduce exactly the flooding this change exists to remove.

### D5 — The renderers are as schema-blind as the registration

The renderer joins the `text` blocks of `result.content` and treats the result as an opaque string. It contains no tool-name literal, no field access into any payload, and no per-tool branch. This preserves the existing requirement that adding, renaming or removing a server tool needs no plugin change, and keeps the scenario "The plugin source contains no tool inventory" true at HEAD.

The one tool-specific value in the output is the canonical name, which arrives from `tools/list` at registration time and is closed over — discovered, not enumerated.

### D6 — Import `Text` and `keyHint` from the host packages, statically, as peer dependencies

`import { Text } from '@earendil-works/pi-tui'` and `import { keyHint } from '@earendil-works/pi-coding-agent'`, both declared in `.pi-plugin/package.json` under `peerDependencies` with range `"*"`.

This is the shape the shipped spec already mandates (`openspec/specs/pi-plugin/spec.md:121`: "The harness's own packages SHALL be declared as `peerDependencies` with the range `"*"` and SHALL NOT be bundled: they are the host, present by construction") and that the harness prescribes (`docs/packages.md:171`: "If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`").

Two reasons beyond convention:

1. **`Text` makes the expanded view identical by construction.** It is the very component `createResultFallback()` builds (`tool-execution.js:109-115`, `new Text(theme.fg("toolOutput", output), 0, 0)`), so the expanded rendering matches today's word wrap, padding and caching rather than approximating it. Its signature is `constructor(text?, paddingX?, paddingY?, customBgFn?)` (`pi-tui/dist/components/text.d.ts`).
2. **`keyHint` gives the operator's real binding**, which the issue asks for explicitly over a hard-coded `Ctrl+O`. It is `theme.fg("dim", keyText(keybinding)) + theme.fg("muted", " " + description)` (`dist/modes/interactive/components/keybinding-hints.js`), and `keyText` reads the live `getKeybindings()` singleton, into which `KeybindingsManager.create()` has already merged `<agentDir>/keybindings.json` (`dist/core/keybindings.js:276-279`).

**Measured, not assumed.** A probe extension with both static imports, loaded through the real CLI as `pi -e ./ext.ts` (a local-path load, so the harness runs no `npm install`), reported `Text=function keyHint=function` and `keyHint('app.tools.expand','to expand')` = `"\x1b[38;2;102;102;102mctrl+o\x1b[39m\x1b[38;2;128;128;128m to expand\x1b[39m"` — the real binding, correctly themed. `new Text('hello world', 0, 0).render(20)` returned `["hello world         "]`. The resolution comes from the loader's jiti alias map (`dist/core/extensions/loader.js:89-110`), which points both specifiers at the host's own loaded entries, so nothing is added to the tarball and the singletons are shared.

The same probe also confirmed **a named export alongside `export default` does not disturb loading**: the loader does `jiti.import(extensionPath, { default: true })` and then checks `typeof factory !== "function"` (`loader.js:368-372`), which reads the default export only. D7 depends on this.

**Alternative rejected: a lazily-resolved dynamic import with a local `ctrl+o` fallback.** It avoids editing shared config, and it was the initial lean. Rejected because it invents a mechanism to sidestep a convention the spec already sets, and because of what the operator sees: the first tool result after start would paint a fallback hint that later mutates into the real one. A hint that changes under the reader is worse than a stable correct one. (Measured while evaluating it: `keyText` returns `""` in print mode, where the keybindings singleton is uninitialised — irrelevant here because print mode renders no tool components, but it is why the fallback path was not free either.)

### D7 — The render logic is a pure named export; `renderResult` is a thin wrapper

A static host import is measurably unresolvable from this repo — `/root/rembric/node_modules/@earendil-works/` does not exist and `.pi-plugin/` matches no `pnpm-workspace.yaml` glob (the `pi-plugin` capability records this deliberate exclusion at `spec.md:15`) — and `plugin.test.ts:28` imports `./index.js` at module level, so D6 breaks the entire test file at load unless `apps/server/vitest.config.ts` aliases the two specifiers to a stub.

**A stub that the assertions run against is not coverage.** The split that prevents it:

- A **named export from `index.ts`** — not a new file, because `spec.md:15` allows exactly four top-level files and `scripts/pi-package.mjs::sharedModules()` (`:33-48`) fails the build on any relative import outside `^\.{1,2}\/bin\/([\w.-]+\.mjs)$`. It is a pure function of `(text, expanded, isError, canonicalName, keyHintText)` returning `string[]`, with no host import anywhere on its path.
- `renderResult` calls `keyHint("app.tools.expand", …)`, passes the resulting string into the pure function, and wraps the lines in `Text`.

So collapsed, expanded and error rendering are asserted against the pure function with a fake `Theme` — possible only because Pi passes the theme as a parameter (`tool-execution.js:248`) rather than requiring a module import — and the stub is exercised by nothing except module loading.

**Editing `apps/server/vitest.config.ts` for a Pi-client concern is a smell, and it is accepted knowingly.** The server's test config is shared by ~75 files; a `resolve.alias` there is global to all of them. It is accepted because the two aliased specifiers are host packages no server test has any reason to import, because the alternative is D6's rejected machinery, and because D7 means the alias cannot silently become what the render tests measure. The config edit carries a comment naming the reason (a `.pi-plugin` static host import), which is the kind of non-obvious _why_ the repo's comment policy permits.

### D8 — No typecheck gate is added, and the gap is stated rather than papered over

Issue #333 asks that "the Pi adapter's local type definitions cover the renderer API without weakening type safety". Today nothing enforces that: `index.ts` is outside every `tsc` project and outside ESLint's type-aware rules (Context).

Adding a gate was considered and is **harder after D6, not easier**: `tsc` over `index.ts` would need `@earendil-works/*` declarations present in CI, which means either a devDependency on `@earendil-works/pi-coding-agent` — whose inbound cost (five provider SDKs) this client's shipped spec already refuses — or a `paths` map onto a global install CI does not have.

So the criterion is answered by review plus D7's behavioural tests, and the absence of a compiler gate is written down. A spec that claimed type coverage here would be claiming a gate that does not exist.

### D9 — Errors are distinguished by glyph and colour, and their full text is reachable the same way

The collapsed error line uses a distinct marker and `theme.fg('error', …)`; `ThemeColor` includes `success`, `error`, `muted` and `dim` (`dist/modes/interactive/theme/theme.d.ts:4`). The host additionally paints the row's background with `toolErrorBg` when its flag is set (`tool-execution.js:205-210`), which D1 is what makes reachable — so the error state is doubly visible without the renderer touching the background.

Expanding an error yields the complete diagnostic text, by the same path as a success: the `mcpError()` payload is `JSON.stringify({ ok: false, code, message, ...extra }, null, 2)` (`apps/server/src/mcp/errors.ts:15`), and under D1 that whole string is the thrown `Error`'s message and therefore the content block Pi renders.

## Risks / Trade-offs

- **[Risk] The stub alias silently becomes the thing under test.** A future arm that drives `renderResult` end-to-end would be asserting against a fake `Text`. → Mitigation: D7's pure function is where every render assertion lives, and a task states that the stub must be inert — the render arms must pass with the stub replaced by a throwing double.
- **[Risk] `apps/server/vitest.config.ts` is shared.** A global alias could shadow a specifier a future server test legitimately wants. → Accepted; no server test imports a host package today, and an alias whose reason is recorded in a comment is discoverable when one does.
- **[Trade-off] Collapsing a two-line result is ceremony, and expansion is global.** → Accepted per D2, for predictability; D3's line count is what makes the ceremony informative rather than opaque.
- **[Risk] D1 changes what the model receives.** A tool result that reported success now reports failure. → This is the intended correction, but it is a behaviour change on a path with no test today, so it gets its own arm plus a mutation check rather than riding on the render tests.
- **[Risk] The unit harness supplies the render context itself**, so it cannot prove the host passes `isError` where this design says it does. → Mitigation: the mandatory real-Pi e2e arm, which drives a genuine failing tool call (a `memory.get` on a fabricated id returns `not_found` through `mcpError`) and observes the error styling in a real TUI. The suite proves the branch; only the e2e proves the input.
- **[Risk] Host version drift.** An older or newer Pi could call the renderer differently. → Partly free: a renderer that throws falls back to today's rendering (`docs/extensions.md:2327-2330`). Not free for D1 — a host that stopped treating a thrown error as a failed call would surface the error text as a success again, which is the pre-change state, not a worse one.

## Migration Plan

No server deployment step, no migration, no derived-data invalidation (`memory_fts`, `memory_vec` and the three entity tables are untouched; nothing here reaches the database). The change ships in a `plugin` release; Pi users pick it up with `pi install npm:@rembric/pi` (unpinned, per this capability's no-version-pin requirement).

First run after upgrade: the next Pi session registers tools with renderers attached and renders compactly. The extension runtime is created per session, so no reload dance is needed and sessions already running are simply unaffected.

Rollback: reverting `@rembric/pi` restores today's rendering immediately. Nothing persisted differs, with one recorded asymmetry — transcripts written under the new version record `isError: true` on MCP application errors, and a rollback stops writing it; no stored transcript becomes unreadable either way.

## Open Questions

- **Does `isPartial` ever fire for these tools?** The adapter's `execute` takes three parameters and never invokes Pi's `onUpdate` callback, so `updateResult(result, isPartial)` should always arrive with `isPartial === false` for Rembric tools — but that is a reading, not a measurement. The default the tasks proceed on: render the same collapsed line either way, so a partial result is never worse than a complete one. The real-Pi arm records what was observed.
- **Does an operator's `keybindings.json` override reach the hint at render time?** `keyText` reads the live singleton and `KeybindingsManager.create()` merges `<agentDir>/keybindings.json` at startup (`dist/core/keybindings.js:276-279`), so the default is yes and the design assumes it. It was measured only with the stock binding (`ctrl+o`). The e2e task carries an override arm; if it turns out the singleton is not the one `keyHint` sees, the hint is wrong for that operator and D6 needs revisiting — it does not break anything else.
- **Should the alias in `apps/server/vitest.config.ts` be scoped rather than global?** Vitest's `resolve.alias` has no per-file scoping, so the options are a global alias or a plugin with a `resolveId` hook. The default taken is the global alias plus a comment; the plugin form is worth revisiting the first time a server test wants a real host package, which is not today.
