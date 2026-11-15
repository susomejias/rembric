## ADDED Requirements

### Requirement: The opencode v2 plugin SHALL deliver file-anchored recall through `execute.before` and the session context hook

File-anchored recall SHALL be wired on the v2 plugin API only. The v1 entry point SHALL NOT gain a tool hook: on v1 the only route is mutating `tool.execute.after` output, which the v1 documentation does not document. The rules below follow the v2 server-plugin documentation (`opencode.ai/docs/build/plugins/server`).

**`ctx.tool.hook("execute.before", …)`**
- The plugin SHALL extend its existing handler, which today only latches tool use. The handler's input type SHALL be widened to the documented fields (`tool`, `sessionID`, `input`).
- It SHALL collect the paths of file tools (the file-path argument) and of the bash tool (the command, through the core's `extractCommandPaths`), resolved against `ctx.location.directory`.
- It SHALL await the core's `fileRecall` within its budget, and queue the lines per session.
- It SHALL NEVER throw, because a throw blocks the tool.

**`ctx.session.hook("context", …)`**
- The existing handler SHALL also push each queued block for that session onto `system` as a text part, then clear the queue.
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
