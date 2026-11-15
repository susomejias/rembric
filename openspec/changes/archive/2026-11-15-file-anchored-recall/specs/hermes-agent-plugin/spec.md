## ADDED Requirements

### Requirement: The Hermes plugin SHALL append file-anchored recall through the documented result-transform hooks

Hermes' `pre_tool_call` can only block, ask for approval or modify args, and it fails closed on timeout or exception. It SHALL NOT be used. These rules follow the hooks guide at hermes-agent v0.22.5, `website/docs/user-guide/features/hooks.md`.

**Registration:** the plugin's `register(ctx)` SHALL register, through `ctx.register_hook`, both hooks below.

**`transform_tool_result`, for the file tools**
- The documentation describes this hook as rewriting "ANY tool's result string … before the model sees it" and lists "inject retrieval-augmented hints into `read_file` results" as a use case. Its return contract: "The first `str` replaces the result … `None` leaves it unchanged".
- It SHALL take the paths from the tool's args.

**`transform_terminal_output`, for terminal commands**
- This hook receives `command`.
- It SHALL take the paths from `command` through the plugin's own Python extractor, which agrees with `file-recall-fixtures.json`.

**Working directory:** Python hook callbacks receive no `cwd`. The working directory SHALL be the `cwd` the memory provider received in `initialize()`.

**What the hooks return:** each hook SHALL return the original result with the rendered lines appended, or `None` when there is nothing to add. When the result is a JSON string, it SHALL stay valid JSON in the form the tool produced: the lines go into a field the model reads. The exact form SHALL be fixed by a spike against the installed Hermes before implementation, and recorded in `tasks.md` and in the plugin source.

**Failure:** any exception SHALL be caught inside the callback and turned into `None`.

#### Scenario: A file read is annotated

- **GIVEN** an eligible memory linked to `src/app.ts`, and Hermes running in that repository with the Rembric plugin
- **WHEN** the agent's `read_file` tool reads `src/app.ts`
- **THEN** the result the model sees SHALL contain `rembric: memories about src/app.ts:` followed by the memory's line
- **AND** the control SHALL pass in the same run: with the server unreachable, the result SHALL be byte-identical to the tool's own output

#### Scenario: A terminal read is annotated

- **WHEN** the agent's terminal tool runs `sed -n 1,20p src/app.ts`
- **THEN** the terminal output the model sees SHALL carry the same rendered lines, once per session
