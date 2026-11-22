## MODIFIED Requirements

### Requirement: Tools are discovered at runtime over MCP and never enumerated in the plugin

The extension SHALL obtain its tool surface by calling `tools/list` against the running server and registering each returned tool with the harness, proxying each `execute` invocation to `tools/call`. The extension SHALL NOT contain a list, map, array, or switch of tool names, nor a copy of any tool's input schema. The one exception is the deferral set this extension imports from the shared core (see "Rarely used tools are registered deferred where the host can load them back"): it decides only how a tool is exposed, never whether it is registered, and it never alters a tool's name, description or schema.

Each registered tool SHALL carry the server's own `description` and `inputSchema` with their **structure** unaltered — no key added, removed, or reordered, no constraint weakened. The single transformation permitted is the tool-name spelling, and it SHALL be applied consistently: to the registered name, and to every model-facing string this client publishes that names a tool (the description, every `description` nested in the schema, and the injected nudges). Renaming the name while leaving the prose dotted would hand the model guidance that names tools its own registry does not contain — the client renames, so the client owns the renaming everywhere it speaks.

Tool **results** SHALL NOT be rewritten: a saved memory's content is the user's text and may legitimately contain a dotted name.

Consequently, adding, renaming, or removing a server tool SHALL require no change to this extension, and the plugin and server tool surfaces cannot desynchronise because only one of them describes the surface.

Because the `inputSchema` travels verbatim, the harness validates arguments against the same schema object the server enforces, so `additionalProperties: false` is applied twice — once before `execute` runs and once on the server. **Only the server-side half is reachable from this repository's suite, and the requirement below says so rather than crediting the suite with the other half.** Driving the harness's validator means importing `@earendil-works/pi-ai`, which carries five provider SDKs — the inbound cost design D7 refuses for this client — so the pre-`execute` half is evidenced **out of band**, by a real harness run, with its measurement recorded in `tasks.md` (3.8). What the suite carries is the server-side refusal, its passing control, and the forwarding assertions that make the two layers see the same schema; a test that calls `execute` directly bypasses the harness's `parameters` handling and therefore evidences the server, not the harness.

#### Scenario: Every server tool is registered with no per-tool plugin code

- **GIVEN** the server registers N tools (N is 23 at the time of writing, at `packages/mcp/src/server.ts`)
- **WHEN** the extension initialises against that server
- **THEN** exactly N tools SHALL be registered with the harness
- **AND** each registered tool SHALL correspond to exactly one server tool under the name mapping fixed by the provider-safe-names requirement, with no tool dropped and none invented

#### Scenario: The plugin source contains no tool inventory

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains no occurrence of any server tool name as a literal (for example `memory.save`, `memory.search`, `memory.judge_batch`) outside of comments and test fixtures

#### Scenario: A proxied call reaches the database

- **GIVEN** a running server and an initialised extension
- **WHEN** the harness invokes the registered `memory.save` tool with a valid title and content
- **THEN** the proxied `tools/call` SHALL return a non-error result
- **AND** an independent `memory.get_batch({ ids: [id] })` SHALL return the saved row in `memories`
- **AND** the control — `memory.get_batch({ ids: [missingId] })` — SHALL return MCP `isError: true`, `memories: []` and an associated `not_found` error for `missingId`

#### Scenario: The forwarded schema is the one both layers enforce

- **WHEN** the value registered as the harness's `parameters` is compared with the server's own `inputSchema`
- **THEN** it SHALL be structurally identical, `$schema` and `additionalProperties: false` included, differing only in the tool-name spellings inside `description` strings
- **AND** a test SHALL go red if anything is stripped from it

#### Scenario: The server refuses a malformed payload (the in-suite half)

- **WHEN** a proxied `tools/call` carries an unknown property, an invalid enum member, or a missing required property
- **THEN** the server SHALL refuse each one against its own strict schema
- **AND** the control — the same call with a valid payload — SHALL succeed
- **AND** this is the boundary the suite exercises: it drives `execute`, so it evidences the server's enforcement and SHALL NOT be described as evidence about the harness

#### Scenario: The harness refuses before `execute` runs (measured out of band)

- **GIVEN** the harness's validator is unreachable from this repository's suite without adding `@earendil-works/pi-ai` and the five provider SDKs it carries
- **WHEN** a real harness run invokes a registered tool with an unknown property, an invalid enum member, or a missing required property
- **THEN** each SHALL be refused with the **harness's** own validation message, before `execute` runs
- **AND** the database SHALL hold no row from any refused call, which is what shows no `tools/call` was sent
- **AND** the evidence SHALL be recorded with its provenance in `tasks.md` rather than attributed to the suite

## ADDED Requirements

### Requirement: Rarely used tools are registered deferred where the host can load them back

The extension SHALL keep the rarely used tools out of each request's tool declarations wherever the host can load them back on demand, and SHALL register every tool as before wherever it cannot. Every Pi request declares each registered, active tool to the model, so before this requirement every request carried all of the server's schemas (26 tools, 45,459 bytes of name, description and parameters measured over the server's real `tools/list`) whether or not the turn used memory. Pi 1.x adds a `deferred` tool exposure: a deferred tool is registered and callable but is not declared to the model until the host's `tool_search` tool loads it (`ToolExposure` in `dist/core/extensions/types.d.ts` of `@earendil-works/pi-coding-agent@1.4.0`). `tool_search` itself is registered inactive (`dist/extensions/tool-search/index.js`, `defaultActive: false`), so a deferred tool with no active `tool_search` cannot be reached at all.

The shared core `apps/plugin/bin/rembric-plugin-core.mjs` SHALL export `RARELY_USED_TOOLS`, the set of canonical tool names this client defers: `memory.stats`, `memory.doctor`, `memory.about`, `memory.compare`, `memory.merge`, `memory.archive`, `memory.timeline`, `memory.session_get_batch` and `memory.search_prompts`. The set SHALL live in the shared core, not in the extension source.

At discovery the extension SHALL defer only when the host offers `getAllTools`, `getActiveTools` and `setActiveTools`, and `getAllTools()` lists a tool named `tool_search` that declares `reachesTools`. In that case it SHALL activate `tool_search` (adding it to the active set once, never twice) and SHALL register each discovered tool whose canonical name is in `RARELY_USED_TOOLS` with `exposure: "deferred"`. Every other tool SHALL be registered exactly as before, with no `exposure` key, so the save, summary and recall tools stay declared on every request.

When any of those conditions fails — an older harness without the tool-listing API, no `tool_search`, a `tool_search` that reaches no tools, or a host call that throws — the extension SHALL register every tool with no `exposure` key, exactly as before this requirement, and SHALL NOT report the tools unavailable. A deferral failure SHALL NOT cost a single tool.

A name in `RARELY_USED_TOOLS` that the server does not publish SHALL have no effect, and a server tool outside the set SHALL register with the host's default exposure, so adding or removing a server tool still needs no change to this extension.

#### Scenario: Rarely used tools are deferred and tool_search is activated

- **GIVEN** a host whose `getAllTools()` lists a `tool_search` that declares `reachesTools`, inactive
- **WHEN** the extension discovers the server's tools
- **THEN** every server tool named in `RARELY_USED_TOOLS` SHALL be registered with `exposure: "deferred"`
- **AND** `tool_search` SHALL be added to the active tool set exactly once
- **AND** every other tool, `memory.save`, `memory.session_summary`, `memory.context` and `memory.search` included, SHALL be registered with no `exposure` key
- **AND** the registered names, descriptions and schemas SHALL equal those registered on a host without tool search

#### Scenario: A deferred tool still proxies to the server

- **WHEN** a deferred tool's `execute` is invoked
- **THEN** it SHALL issue `tools/call` with the canonical name and return the server's result

#### Scenario: A host that cannot load deferred tools gets every tool direct

- **GIVEN** a host without the tool-listing API, a host with no `tool_search`, a host whose only tool-reaching tool is not `tool_search`, a host whose `tool_search` declares no `reachesTools`, or a host whose tool API throws
- **WHEN** the extension discovers the server's tools
- **THEN** every server tool SHALL be registered with no `exposure` key
- **AND** the active tool set SHALL be left unchanged
- **AND** no "tools unavailable" notification SHALL be shown

#### Scenario: The deferral set names only published tools

- **WHEN** `RARELY_USED_TOOLS` is compared with the server's `tools/list`
- **THEN** every name in the set SHALL be a tool the server publishes

### Requirement: A suppressed run SHALL NOT receive the server instructions

The extension appends the server's `initialize.instructions` (1,431 bytes for a path-scoped connection) to the system prompt on `before_agent_start`. A run the extension suppresses as a non-primary process (`ctx.mode === "rpc"`, a declared child marker, or the pi-subagents `<active_agent name=` tag; see "The Pi extension SHALL suppress session lifecycle persistence for non-primary pi processes") owns no session row and is told nothing about the session protocol by its own nudges, so the protocol text there is cost with no reader.

On a suppressed run the extension SHALL NOT append the instructions. Tool registration in a suppressed run SHALL be unchanged. On every other run — interactive, print or JSON without a child signal, and any run `REMBRIC_TRACK_SESSION=1` forces — the instructions SHALL be appended exactly as before, and the session-opening nudge that carries the save and summary reminders SHALL still be delivered in the turn's message.

#### Scenario: A suppressed run gets no instructions

- **GIVEN** a run suppressed by `PI_SUBAGENT_CHILD=1`, by `ctx.mode === "rpc"`, or by an `<active_agent name=` tag in its system prompt
- **WHEN** `before_agent_start` fires
- **THEN** the result SHALL carry no `systemPrompt`
- **AND** every server tool SHALL still be registered

#### Scenario: A primary run still gets the instructions and the reminders

- **GIVEN** a print-mode run with no child signal
- **WHEN** `before_agent_start` fires on its first turn with system prompt `BASE`
- **THEN** the result's `systemPrompt` SHALL be `BASE`, a blank line, and the server's instructions with tool names in the registered spelling
- **AND** the result's message SHALL contain the session-opening nudge
