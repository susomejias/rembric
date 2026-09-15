## ADDED Requirements

### Requirement: The Pi extension SHALL suppress session lifecycle persistence for Gentle Pi child processes

Gentle Pi runs every subagent as a separate `pi --mode rpc` child process and marks that
process with `GENTLE_PI_AGENTS_CHILD=1` in its environment (inherited by any deeper
descendants). The parent conversation, not the child, is the durable session boundary:
a child process that registered its own row would surface every delegated task as an
ordinary top-level Pi session whose title is the delegated prompt and whose summary is a
raw transcript, and an interrupted child would linger as a ghost row.

The extension SHALL therefore read that marker once per process and, when it is present,
mark each host session id as a sub-agent through the shared core's `markSubAgent` before
any lifecycle call in `before_agent_start`. The shared core's sub-agent guards then
suppress the `ensure`, the turn report, the transcript flush, the recall-hints request
and the close for that session — the same contract the opencode plugin fulfils via its
`parentID` signal and the Hermes plugin via its non-primary agent contexts. Rembric's MCP
tools SHALL stay fully available inside the child: only automatic session persistence is
suppressed, never tool registration or tool calls.

Because a child never creates a row, the extension SHALL NOT issue the MCP identity
declaration (`memory.session_resume`) for a child session: there is no row to declare,
and every attempt would fail with `session_not_found`. A child's `memory.save` calls
resolve through the server's windowed sole-active lookup like any other unbound
transport — attaching to the parent's row when it is the sole active one, and to nothing
otherwise — so no child write ever mints a row.

#### Scenario: A Gentle Pi child process creates no session row

- **GIVEN** a Pi process started with `GENTLE_PI_AGENTS_CHILD=1`
- **WHEN** `before_agent_start` fires
- **THEN** no `POST /api/<slug>/sessions` is issued for the child's session id
- **AND** no session row exists for that id

#### Scenario: A Gentle Pi child process writes no summary and never ends

- **GIVEN** a Pi process started with `GENTLE_PI_AGENTS_CHILD=1`
- **WHEN** `agent_settled` and then `session_shutdown` fire
- **THEN** no `POST /summary` and no `POST /end` is issued for the child's session id

#### Scenario: A Gentle Pi child process skips the MCP identity declaration

- **GIVEN** a Pi process started with `GENTLE_PI_AGENTS_CHILD=1`
- **WHEN** `before_agent_start` fires
- **THEN** no `memory.session_resume` call is made on the MCP transport

#### Scenario: Rembric tools stay available inside the child

- **GIVEN** a Pi process started with `GENTLE_PI_AGENTS_CHILD=1`
- **WHEN** `session_start` completes
- **THEN** the server's tools are registered exactly as in a primary session
- **AND** a proxied `memory.save` call reaches the database

#### Scenario: A primary session is unaffected

- **GIVEN** a Pi process started without `GENTLE_PI_AGENTS_CHILD`
- **WHEN** `before_agent_start` fires
- **THEN** the session row is created and resumed exactly as the other requirements of
  this capability pin
