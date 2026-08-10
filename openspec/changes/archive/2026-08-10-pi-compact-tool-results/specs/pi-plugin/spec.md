## ADDED Requirements

### Requirement: Tool results render collapsed by default and expand to the complete original text

The extension SHALL supply a `renderResult` for every tool it registers, so a Rembric tool result occupies one line of the transcript by default. Without one, the harness renders the whole payload: `hasRendererDefinition()` is true for any registered tool (`dist/modes/interactive/components/tool-execution.js:75-77` of `@earendil-works/pi-coding-agent@0.84.1`), so the result slot falls back to `createResultFallback()` (`:109-115`), which wraps the entire text, and the server pretty-prints — `apps/server/src/mcp/result.ts:7` is `const text = JSON.stringify(payload, null, 2);`.

Collapsing SHALL apply to **every** tool returned by `tools/list`, unconditionally. No line-count, byte-count or per-tool condition SHALL select between collapsed and expanded rendering. A threshold would make the collapsed state depend on a number the operator cannot see, and would require per-tool knowledge this client deliberately does not have.

The collapsed line SHALL carry, at minimum: an outcome indication distinguishing success from failure, a size signal derived from the result text, and a hint naming the key that expands it. The size signal SHALL be a count of newline-delimited lines in the result text, **not** of rendered terminal rows: rendered rows depend on viewport width and would change under a resize while describing an unchanged payload. Nothing SHALL branch on that count — it is displayed, never tested.

The expand hint SHALL be derived from the harness's configured binding for `app.tools.expand` rather than hard-coding a key. The extension SHALL NOT assume the operator's binding is the stock `ctrl+o` (`dist/core/keybindings.js:27`, `{ defaultKeys: "ctrl+o", description: "Toggle tool output" }`); an override loaded from `<agentDir>/keybindings.json` (`:276-279`) MUST be reflected.

When the harness's tool-output expansion is on, the renderer SHALL emit the **complete** original text, with nothing elided, truncated or reformatted. The expanded rendering SHALL be produced by the same component the harness's own fallback uses, so word wrap and padding match rather than approximate.

The specification SHALL NOT promise per-row expansion. The harness holds a single `toolOutputExpanded` flag (`dist/modes/interactive/interactive-mode.js:262`) and pushes it to every expandable child of the chat container (`setToolsExpanded`, `:3308-3324`), so expanding one Rembric result expands every tool row in the transcript. This is the harness's behaviour and this client SHALL NOT claim otherwise.

The extension SHALL additionally supply a `renderCall` that renders the tool's **canonical dotted** name. Without one the call line falls back to `createCallFallback()` (`:106-108`), `theme.fg("toolTitle", theme.bold(this.toolName))`, where `toolName` is the underscored spelling registration uses to satisfy a provider's `^[a-zA-Z0-9_-]+$` constraint — a spelling that exists for the provider, not for the operator. The call renderer SHALL render the name and SHALL NOT render tool arguments: selecting which argument to show is per-tool knowledge, and one client tool's argument is the memory content this requirement exists to stop flooding the transcript.

Both renderers SHALL be generic across the discovered tool surface. They SHALL contain no tool-name literal, no field access into any tool's response payload, and no per-tool branch, so adding, renaming or removing a server tool continues to require no change to this extension. The only tool-specific value either renderer emits is the canonical name closed over at registration, which was discovered from `tools/list` and not enumerated in the plugin.

The MCP result handed to the model SHALL be unaffected by rendering. Rendering is a display concern and SHALL NOT alter the content returned from `execute`.

#### Scenario: A successful result is one line by default

- **GIVEN** a registered Rembric tool whose result text spans many lines
- **WHEN** the harness renders the result with expansion off
- **THEN** the rendered output SHALL be a single line
- **AND** it SHALL indicate success, the count of lines in the result text, and the configured expand key
- **AND** it SHALL NOT contain the result text

#### Scenario: Expansion restores the complete original text

- **GIVEN** the same result, whose text is non-empty and spans more than one line
- **WHEN** the harness renders it with expansion on
- **THEN** the rendered output SHALL contain the complete original text, byte for byte
- **AND** the assertion SHALL be made over a non-empty payload, so an empty result cannot make it vacuously true

#### Scenario: Collapsing is unconditional

- **GIVEN** two registered tools, one whose result text is a single line and one whose result text spans hundreds
- **WHEN** each is rendered with expansion off
- **THEN** both SHALL render collapsed
- **AND** no threshold SHALL cause either to render its text

#### Scenario: The expand hint follows the operator's binding

- **GIVEN** an operator whose `keybindings.json` rebinds `app.tools.expand` away from the default
- **WHEN** a result is rendered collapsed
- **THEN** the hint SHALL name the operator's configured key
- **AND** the extension SHALL NOT emit a hard-coded key literal

#### Scenario: The call line names the canonical tool

- **WHEN** the harness renders the call slot for a registered Rembric tool
- **THEN** it SHALL show the canonical dotted tool name, not the underscored registration spelling
- **AND** it SHALL NOT render the call's arguments

#### Scenario: The renderers name no tool

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** the render path SHALL contain no server tool name as a literal and no access to any response field
- **AND** a tool added to the server SHALL render through the same code with no plugin change

#### Scenario: A renderer failure degrades to the harness fallback

- **GIVEN** a harness version whose renderer contract differs from the one this extension was written against
- **WHEN** a renderer throws
- **THEN** the harness SHALL fall back to its own rendering — the tool name for the call slot and the raw `content` text for the result slot
- **AND** the extension SHALL remain loaded and its tools SHALL remain callable

### Requirement: An MCP error result is signalled by throwing, and rendered as a failure

The extension SHALL signal a failed tool call by **throwing** from `execute` when the MCP result carries `isError: true`. It SHALL NOT return an `isError` property on the result object, and no such property SHALL remain in the source.

Returning the property is inert, and this is measured rather than assumed. `AgentToolResult` (`@earendil-works/pi-agent-core/dist/types.d.ts:316-330`) declares `content`, `details`, `usage?`, `addedToolNames?` and `terminate?` and has no `isError` member; `executePreparedToolCall` returns `{ result, isError: false }` hardcoded on the success path (`pi-agent-core/dist/agent-loop.js:470`), the only `isError: true` in it being its `catch` (`:477`); and the TUI spreads the harness's flag last — `component.updateResult({ ...event.result, isError: event.isError })` (`dist/modes/interactive/interactive-mode.js:2641`). The harness documents the rule at `docs/extensions.md:1984`: "To mark a tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an error from `execute`. Returning a value never sets the error flag regardless of what properties you include in the return object."

The text the model receives SHALL be unchanged by this. The harness's catch builds `createErrorToolResult(message)` = `{ content: [{ type: "text", text: message }], details: {} }` (`pi-agent-core/dist/agent-loop.js:519-524`), so throwing an error whose message is the MCP result text yields the identical single text block the extension returns today. What SHALL change is the flag: the `toolResult` message's `isError` becomes `true` (`agent-loop.js:534-547`), which is the correction — a Rembric `not_found` or `scope_locked` response has been reported to the model as a success.

This SHALL NOT alter the handling of transport or protocol failures, which already throw out of the extension's own JSON-RPC send path on a non-2xx response or a JSON-RPC `error` member and are already flagged correctly.

A renderer SHALL read the error state from the render **context**, never from the result argument. The harness narrows the first renderer argument to `{ content, details }` (`dist/modes/interactive/components/tool-execution.js:248`) and supplies the flag only on the render context, built as `isError: this.result?.isError ?? false` (`:103`). A renderer reading it from the result argument would be permanently false and its error branch dead.

A failed call SHALL render collapsed with a visibly distinct outcome indication, and expansion SHALL reveal its complete diagnostic text by the same path as a successful result. The diagnostic text is the server's error payload — `JSON.stringify({ ok: false, code, message, ...extra }, null, 2)` (`apps/server/src/mcp/errors.ts:15`) — so the `code` field an operator needs is inside the text the expansion reveals, and no requirement here depends on parsing it.

#### Scenario: An MCP error result marks the call failed

- **GIVEN** a proxied `tools/call` whose MCP result carries `isError: true`
- **WHEN** `execute` handles it
- **THEN** it SHALL throw an error whose message is the result text
- **AND** it SHALL NOT return a result object carrying an `isError` property

#### Scenario: The model receives the same text, now flagged

- **GIVEN** the same failing call
- **WHEN** the harness finalizes the tool call
- **THEN** the tool-result content SHALL be a single text block equal to the MCP result text
- **AND** the tool result SHALL be flagged as an error
- **AND** the control — a successful call — SHALL be flagged as not an error, with its text likewise unchanged

#### Scenario: The error branch reads the render context

- **GIVEN** a render invocation whose context reports an error and whose result argument carries no error property
- **WHEN** the result is rendered collapsed
- **THEN** the output SHALL indicate failure
- **AND** a renderer that consulted only the result argument SHALL be shown by test to render success for the same input

#### Scenario: An error expands to its full diagnostic text

- **GIVEN** a failed call whose diagnostic payload spans more than one line
- **WHEN** the result is rendered with expansion on
- **THEN** the rendered output SHALL contain the complete diagnostic text, byte for byte, including the error code field

#### Scenario: The error path is covered by tests that fail without it

- **WHEN** the throw is replaced by the previous return-with-flag and the test suite is re-run
- **THEN** at least one test naming the error path SHALL fail
- **AND** when the renderer's error condition is inverted, the collapsed-failure test SHALL fail

## MODIFIED Requirements

### Requirement: MCP transport is Streamable HTTP with a Bearer token and no runtime dependency

The extension SHALL connect to `${REMBRIC_SERVER_URL}/mcp/<slug>` over Streamable HTTP, sending `Authorization: Bearer ${REMBRIC_API_TOKEN}`, and SHALL implement exactly the wire surface it needs: `initialize`, the initialized notification, `tools/list`, and `tools/call`.

The extension SHALL declare **no runtime `dependencies`**. The harness's own packages SHALL be declared as `peerDependencies` with the range `"*"` and SHALL NOT be bundled: they are the host, present by construction, and a narrower range would assert a compatibility claim broader than what has been measured.

The reason no runtime dependency is permitted is measured behaviour of the harness's installer, not preference: for a local-path installation the harness does **not** run `npm install` (it does for registry and git specs), so a declared runtime dependency would be absent in exactly the install shape used for development and testing.

The extension MAY import from the harness's own packages, and such an import SHALL be static and SHALL be declared as a `peerDependency` with range `"*"` — never as a `dependency`, never bundled, and never through a lazily-resolved dynamic import invented to avoid declaring it. The harness prescribes exactly this shape (`docs/packages.md:171` of `@earendil-works/pi-coding-agent@0.84.1`: "If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them"), and its extension loader resolves those specifiers to the host's own already-loaded entries through an alias map (`dist/core/extensions/loader.js:89-110`), so the import adds nothing to the tarball and shares the host's singletons rather than instantiating a second copy.

Because those specifiers resolve **only** inside the harness, a static host import is unresolvable from this repository, where `apps/plugin/.pi-plugin/` matches no workspace glob and no such package is installed. The extension's test file imports the extension module at load time, so an unaliased host import fails the entire test file rather than one assertion. `apps/server/vitest.config.ts` SHALL therefore alias each imported host specifier to a stub, and the alias SHALL carry a comment naming the reason.

That stub SHALL NOT become the subject of the tests. Logic whose behaviour this capability specifies SHALL be reachable through an export that does not import a host package, so the behavioural assertions run against real code with nothing stubbed, and the host-importing wrapper stays thin enough that the stub is exercised by module loading alone.

Because the extension connects to `/mcp/<slug>`, the server resolves its project through the existing path-scoping contract (`apps/server/src/mcp/_shared.ts::resolveEffectiveScope`): the connection is fixed to that one project and no tool argument can name another. This extension introduces no new scope-resolution path.

#### Scenario: Package declares no runtime dependencies

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it declares no `dependencies` key, or a `dependencies` key whose value is an empty object
- **AND** every harness package the extension imports appears under `peerDependencies` with the range `"*"`
- **AND** no `bundledDependencies` / `bundleDependencies` key is present

#### Scenario: Local-path install works with nothing installed

- **GIVEN** the extension is installed from a local path, so the harness runs no dependency install
- **WHEN** a session starts
- **THEN** tool discovery and registration SHALL succeed
- **AND** every static host import SHALL resolve
- **AND** no module-resolution error SHALL be emitted

#### Scenario: The test config aliases every host specifier the extension imports

- **WHEN** `apps/plugin/.pi-plugin/index.ts` and `apps/server/vitest.config.ts` are read at HEAD
- **THEN** every bare `@earendil-works/*` specifier imported by the extension SHALL have a corresponding alias entry
- **AND** the extension's test file SHALL load without a module-resolution error

#### Scenario: The stub is not what the render tests measure

- **GIVEN** the aliased stub is replaced by a double that throws on any use
- **WHEN** the tests covering collapsed, expanded and error rendering are run
- **THEN** they SHALL still pass, because they exercise the non-host-importing export

#### Scenario: A slug naming no project is refused, not widened

- **GIVEN** `.rembric` names a `PROJECT_SLUG` for which no project exists
- **WHEN** the extension initialises
- **THEN** the server SHALL refuse the connection with `project_not_found`
- **AND** the extension SHALL NOT fall back to the default project
