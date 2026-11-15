## ADDED Requirements

### Requirement: The opencode v2 plugin SHALL deliver file-anchored recall through `execute.before` and the session context hook

File-anchored recall SHALL be wired on the v2 plugin API only. The v1 entry point SHALL NOT gain a tool hook: on v1 the only route is mutating `tool.execute.after` output, which the v1 documentation does not document. The rules below follow the v2 server-plugin documentation (`opencode.ai/docs/build/plugins/server`) and the tools page (`opencode.ai/docs/tools/`). Where those pages are silent, they follow opencode's source on its `dev` branch: the `execute.before` event type in `packages/plugin/src/promise/tool.ts`, its dispatch in `packages/core/src/tool.ts` and `packages/core/src/plugin/hooks.ts`, and the tool input schemas in `packages/core/src/tool/plugin/{read,edit,write,shell}.ts`.

**`ctx.tool.hook("execute.before", …)`**
- The plugin SHALL extend its existing handler, which today only latches tool use. The handler's input type SHALL be widened to the documented fields (`tool`, `sessionID`, `input`).
- The event's `tool` is the model-facing call name. It SHALL collect the `path` argument of `read`, `edit` and `write`, resolved against `ctx.location.directory`. It SHALL collect the paths in the `command` of `shell`, through the core's `extractCommandPaths`, resolved against the call's `workdir` when one is given and against `ctx.location.directory` otherwise. 2.x has no `bash` tool.
- The host awaits every `execute.before` callback before the tool runs, and a failure rejects the call. The handler SHALL therefore start the core's `fileRecall` without awaiting it, and SHALL queue the pending lookup per session.
- It SHALL NEVER throw.

**`ctx.session.hook("context", …)`**
- The existing handler SHALL also take that session's queued lookups and clear the queue, await them, and push their lines onto `system` as one text part when there are any.
- The documentation states that changes "affect only the outgoing model call, not persisted history" and that the hook runs "for the agent loop, including tool-driven continuations". So the note reaches the request that carries the tool's result, and never accumulates in history.

**Sub-agents:** sessions that the plugin's existing sub-agent filter excludes SHALL be skipped.

#### Scenario: A read reaches the next request once

- **GIVEN** an eligible memory linked to `src/app.ts` and an opencode v2 session in that repository
- **WHEN** the agent's read tool reads `src/app.ts`
- **THEN** the next `context` invocation for that session SHALL push one system text part starting `rembric: memories about src/app.ts:`
- **AND** the invocation after it SHALL push nothing for that file

#### Scenario: The v1 entry point is unchanged

- **WHEN** the v1 plugin export is loaded
- **THEN** it SHALL register no `tool.execute.before` or `tool.execute.after` hook

## MODIFIED Requirements

### Requirement: Install script contract

`apps/plugin/.opencode-plugin/install.sh` SHALL follow the current install contract, which supersedes the copied-launcher details retained in
its historical scenarios below. It SHALL remain a POSIX `sh` script with `set -eu`; copy the plugin, the moved
bridge dotenv module, and `rembric-plugin-core.mjs`; verify every rewritten
shared import; print rather than write the MCP snippet; and never create,
modify, or delete `opencode.json`.

It SHALL fetch `rembric-dotenv.mjs` from
`apps/plugin/mcp-bridge/rembric-dotenv.mjs` and
`rembric-plugin-core.mjs` from `apps/plugin/bin/`. The printed command SHALL be
`['npx', '-y', '@rembric/mcp-bridge@<exact-version>']` with literal URL and
token placeholders. It SHALL not copy or remove the deleted repository
launcher; existing user-owned launcher files are handled by the config hook.
The moved dotenv source is required and its absence SHALL fail loudly.

#### Scenario: Idempotent re-run

The published scenario remains current for the shared files and installer
state; the launcher copy it formerly implied is superseded.

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** every destination file exists after each invocation, including `rembric-plugin-core.mjs`
- **AND** their contents match the source files

#### Scenario: Snippet has expanded $HOME but unexpanded placeholders

The published path assertion is retained for MODIFIED-body provenance. Fresh
installs now print the pinned npx command, not a launcher path.

- **GIVEN** `$HOME = /Users/alice`
- **WHEN** the install script prints the MCP snippet
- **THEN** the snippet's `command` SHALL be the pinned `npx` form and SHALL contain no `/Users/alice` path — the title's first half describes the form this change replaces, and is kept because a published scenario title cannot be renamed inside a MODIFIED block
- **AND** the snippet contains the literal placeholders `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` (NOT substituted)

#### Scenario: Missing dotenv source aborts at its new path

- **GIVEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script exits with a non-zero code
- **AND** writes a stderr message naming `apps/plugin/mcp-bridge/rembric-dotenv.mjs`, not the retired `apps/plugin/bin/` path

#### Scenario: A single unrewritten import aborts the install

The published scenario remains current; the two rewritten imports are the
moved dotenv module and the shared session-protocol core.

- **GIVEN** the installed plugin file references the absolute dotenv path but still carries the relative core import
- **WHEN** `install.sh` completes its rewrite verification
- **THEN** it SHALL exit non-zero naming the failed rewrite
- **AND** it SHALL NOT leave the broken plugin file at `${HOME}/.config/opencode/plugins/rembric.ts`
- **AND** the same SHALL hold with the two rewrites reversed — an absolute core path alongside a surviving relative `../mcp-bridge/rembric-dotenv.mjs` import

#### Scenario: An absent opencode.json remains absent

- **WHEN** the installer runs with no `${HOME}/.config/opencode/opencode.json`
- **THEN** the file SHALL remain absent
- **AND** stdout SHALL contain the exact pinned npx MCP snippet

#### Scenario: An existing opencode.json is byte-identical

- **WHEN** the installer runs with an existing `opencode.json`
- **THEN** its bytes SHALL be unchanged
- **AND** stdout SHALL contain the snippet for manual paste

#### Scenario: Missing bridge source aborts

- **GIVEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script SHALL exit non-zero
- **AND** writes a stderr message naming `apps/plugin/mcp-bridge/rembric-dotenv.mjs`
