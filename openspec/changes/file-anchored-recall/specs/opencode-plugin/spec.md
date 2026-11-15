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
