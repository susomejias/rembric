## MODIFIED Requirements

### Requirement: Tools are discovered at runtime over MCP and never enumerated in the plugin

The extension SHALL obtain its tool surface by calling `tools/list` against the running server and registering each returned tool with the harness, proxying each `execute` invocation to `tools/call`. The extension SHALL NOT contain a list, map, array, or switch of tool names, nor a copy of any tool's input schema.

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
