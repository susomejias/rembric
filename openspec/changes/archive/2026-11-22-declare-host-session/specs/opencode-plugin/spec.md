## ADDED Requirements

### Requirement: The opencode plugin SHALL attribute every Rembric tool call to the root session that issued it

One opencode process can run several root sessions concurrently (`opencode serve`, the web UI), and they share one MCP bridge. Attribution is therefore per call, never per process: the plugin SHALL NOT publish a host binding (`rembric-host-binding.mjs` is neither imported by the plugin nor installed by its installer), so it never sends `X-Rembric-Session`.

Both entry points SHALL rewrite the arguments of every Rembric MCP tool call that declares `sessionId` for attribution, before the tool runs:

- **1.x:** a `tool.execute.before` handler, which receives `{ tool, sessionID, callID }` and `{ args }`. opencode passes the same `args` object to the MCP call, so the handler SHALL set `args.sessionId` on that object in place and SHALL NOT replace `output.args`.
- **2.x:** the existing `ctx.tool.hook("execute.before")` handler, which receives `{ tool, sessionID, input }`; it SHALL set `sessionId` on `input` in place. The host copies `input` back to the call after the callback (`packages/plugin/src/promise/adapter.ts` on opencode's `dev` branch).

**Which calls.** opencode names an MCP tool `<server>_<tool>`, with every character outside `[A-Za-z0-9_-]` replaced by `_`, and the plugin's config hook names the server `rembric`. The rewritten set SHALL be exactly `rembric_memory_save`, `rembric_memory_confirm_batch`, `rembric_memory_merge`, `rembric_memory_save_prompt`, `rembric_memory_capture_passive`, `rembric_memory_session_summary` and `rembric_memory_session_end`.

- A tool that does not declare `sessionId` SHALL NOT gain one, because Rembric's tool input schemas are strict and refuse an unknown property.
- `rembric_memory_session_resume` SHALL NOT be touched: naming the session is that tool's purpose.
- `rembric_memory_search_prompts` SHALL NOT be touched: its `sessionId` is a search filter, not an attribution.

**Which id.** The value SHALL be the **root** session of the call's `sessionID`, and it SHALL replace any `sessionId` the model passed.

- A sub-agent session SHALL resolve to its root by following the `parentID` the plugin recorded when the sub-agent was created (`session.created` in both majors), through any depth of nesting.
- The resolved root SHALL be a session the plugin registered with the server (`POST /api/<slug>/sessions` succeeded), so the server knows it under this token and project.
- When no root resolves, the arguments SHALL be left unchanged. This covers: a session the plugin never saw, a sub-agent recognised only by its title, a parent cycle, a deleted session, a root whose registration failed, and a disabled plugin (missing credentials or project).

The handler SHALL NOT perform HTTP work and SHALL NEVER throw into the host, because a throw rejects the tool call.

#### Scenario: Two concurrent root sessions in one opencode process each attribute to their own session

- **GIVEN** one plugin instance with registered root sessions `<A>` and `<B>`, `<B>` created after `<A>`
- **WHEN** session `<A>` calls `rembric_memory_save` with `sessionId: "<B>"`
- **THEN** the call SHALL run with `sessionId: "<A>"`
- **WHEN** session `<B>` calls `rembric_memory_save` without a `sessionId`
- **THEN** the call SHALL run with `sessionId: "<B>"`
- **AND** an interleaved turn in `<A>` SHALL NOT change what a later call from `<B>` carries

#### Scenario: A sub-agent call carries its root's id

- **GIVEN** a sub-agent `<C>` created with `parentID` `<A>`, and a sub-agent `<D>` created with `parentID` `<C>`
- **WHEN** `<C>` or `<D>` calls `rembric_memory_save`, with or without a `sessionId`
- **THEN** the call SHALL run with `sessionId: "<A>"`

#### Scenario: Only the attributing tools are rewritten

- **GIVEN** a registered root session `<A>`
- **WHEN** `<A>` calls `rembric_memory_search`, `rembric_memory_session_start`, `rembric_memory_context`, a tool of another MCP server, or a built-in tool
- **THEN** its arguments SHALL be unchanged and SHALL NOT gain `sessionId`
- **WHEN** `<A>` calls `rembric_memory_session_resume` or `rembric_memory_search_prompts` with a `sessionId`
- **THEN** that `sessionId` SHALL be unchanged

#### Scenario: An unresolvable root leaves the call as the model sent it

- **WHEN** a call comes from a session the plugin never saw, a title-only sub-agent, a deleted sub-agent, a session in a parent cycle, or a root whose registration failed, or while the plugin is disabled
- **THEN** its arguments SHALL be unchanged
- **AND** arguments that cannot carry a property (`null`, a string, a frozen object) SHALL NOT make the handler throw

#### Scenario: No host binding is published

- **WHEN** a root session is created
- **THEN** no file SHALL exist at `<home>/.cache/rembric/host-sessions/<process.pid>.json` written by the plugin

## MODIFIED Requirements

### Requirement: Event handler set

The plugin module's returned object SHALL declare exactly the following event handler properties, no more and no fewer:

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, `"server.instance.disposed"`, `"message.updated"`, `"message.part.updated"`, and `"session.idle"`. Any other `event.type` values SHALL be silently ignored. None of these five are top-level `Hooks` object keys in the opencode plugin API; all are members of the `Event` union delivered exclusively through this dispatcher.
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map). The handler SHALL NOT POST any HTTP request.
3. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.
4. `"tool.execute.before": async (input, output) => ...` — per-call session attribution (see "The opencode plugin SHALL attribute every Rembric tool call to the root session that issued it"). It SHALL NOT perform HTTP work and SHALL NOT throw.

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). Its `tool.execute.before` hook SHALL only attribute the session: it SHALL NOT block, reject or otherwise guard a tool call. The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` handler and the `event` dispatcher's `message.updated`/`message.part.updated`/`session.idle` branches MUST treat the `sessionMessages` Map (plus the `messageRoles`/`assistantParts` accumulators for the message branches, and the debounce-timer map for `session.idle`) as their only side effects beyond the deliberate HTTP POST each performs. An invariant test (`apps/web/src/test/invariants.test.ts`) SHALL fail the build if the `chat.message` handler invokes `rembricPost`, `fetch`, or any other HTTP work (the `event` dispatcher's `message.updated`, `message.part.updated`, and `session.idle` branches are exempted from this specific invariant since `session.idle`'s HTTP POST is the intended primary flush mechanism — see "Session.idle handler (periodic flush)").

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["config", "event", "chat.message", "experimental.session.compacting", "tool.execute.before"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist — in particular, `"message.updated"`, `"message.part.updated"`, and `"session.idle"` SHALL NOT appear as top-level keys

#### Scenario: message.updated, message.part.updated, and session.idle events reach the event dispatcher

- **WHEN** opencode emits an event of type `"message.updated"`, `"message.part.updated"`, or `"session.idle"`
- **THEN** the plugin's `event` hook SHALL receive it (none has its own top-level `Hooks` key) and route it to the corresponding branch described in "Message.updated handler tracks role" / "Message.part.updated handler accumulates assistant transcript" and "Session.idle handler (periodic flush)"

### Requirement: The opencode v2 plugin SHALL deliver file-anchored recall through `execute.before` and the session context hook

File-anchored recall SHALL be wired on the v2 plugin API only. The v1 entry point SHALL NOT do file recall and SHALL NOT register `tool.execute.after`: on v1 the only route is mutating `tool.execute.after` output, which the v1 documentation does not document. (Its `tool.execute.before` hook exists for session attribution only.) The rules below follow the v2 server-plugin documentation (`opencode.ai/docs/build/plugins/server`) and the tools page (`opencode.ai/docs/tools/`). Where those pages are silent, they follow opencode's source on its `dev` branch: the `execute.before` event type in `packages/plugin/src/promise/tool.ts`, its dispatch in `packages/core/src/tool.ts` and `packages/core/src/plugin/hooks.ts`, and the tool input schemas in `packages/core/src/tool/plugin/{read,edit,write,shell}.ts`.

**`ctx.tool.hook("execute.before", …)`**

- The plugin SHALL extend its existing handler, which latches tool use and attributes the session (see "The opencode plugin SHALL attribute every Rembric tool call to the root session that issued it"). The handler's input type SHALL be widened to the documented fields (`tool`, `sessionID`, `input`).
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
- **THEN** it SHALL register no `tool.execute.after` hook
- **AND** its `tool.execute.before` hook SHALL start no file recall for a `read` call
