## ADDED Requirements

### Requirement: The Pi extension SHALL suppress session lifecycle persistence for non-primary pi processes

A Rembric session row exists for a pi process's primary conversation. Some pi processes
are not primary conversations: another program drives them as a tool, or their spawner
declares them children. When such a process registered its own row, every delegated task
surfaced as an ordinary top-level Pi session whose title is the delegated prompt and
whose summary is a raw transcript, and an interrupted one lingered as a ghost row.

The extension SHALL therefore mark the host session as a sub-agent through the shared
core's `markSubAgent` — which suppresses the `ensure`, the turn report, the transcript
flush, the recall request and the close for that session — when ANY of the following
holds:

- The host declares the process programmatically driven: pi's `ctx.mode` is `"rpc"`,
  the mode every orchestrator runtime (gentle-pi, pi-subagents, IDE integrations,
  scripts) uses when it spawns `pi --mode rpc` children. This signal is intrinsic to
  the child and requires no cooperation from the spawner.
- The spawner declares the child with `REMBRIC_SUBAGENT=1` — the generic contract for
  any orchestrator whose children are not pi RPC processes (SDK runners, plugins).
- The spawner sets gentle-pi's `GENTLE_PI_AGENTS_CHILD=1`, honoured as a legacy alias
  for the installed base.

`REMBRIC_TRACK_SESSION=1` SHALL override all of the above and force the session to
register: an explicit operator opt-in tracks a process that would otherwise be
suppressed. Interactive (`tui`), print and JSON sessions keep registering — a one-shot
`pi -p` or `pi --mode json` run is the only conversation its process has, so it is the
primary one. JSON mode is `ctx.mode === "json"`, print mode `"print"`.

Rembric's MCP tools SHALL stay fully available inside a suppressed process: only
automatic session persistence is suppressed, never tool registration or tool calls.
Because a suppressed process never creates a row, the extension SHALL NOT issue the MCP
identity declaration (`memory.session_resume`) for it: there is no row to declare, and
every attempt would fail with `session_not_found`. Its `memory.save` calls resolve
through the server's windowed sole-active lookup like any other unbound transport —
attaching to the orchestrator's row when it is the sole active one, and to nothing
otherwise — so no child write ever mints a row.

#### Scenario: An RPC-driven process creates no session row

- **GIVEN** a pi process whose host context reports `ctx.mode === "rpc"`
- **WHEN** `before_agent_start` fires
- **THEN** no `POST /api/<slug>/sessions` is issued for the process's session id
- **AND** no session row exists for that id

#### Scenario: A declared child process creates no session row

- **GIVEN** a pi process started with `REMBRIC_SUBAGENT=1`
- **WHEN** `before_agent_start` fires
- **THEN** no `POST /api/<slug>/sessions` is issued for the process's session id
- **AND** no session row exists for that id

#### Scenario: The legacy gentle-pi marker remains honoured

- **GIVEN** a pi process started with `GENTLE_PI_AGENTS_CHILD=1`
- **WHEN** `before_agent_start` fires
- **THEN** no `POST /api/<slug>/sessions` is issued for the process's session id

#### Scenario: An explicit tracking override wins

- **GIVEN** a pi process whose host context reports `ctx.mode === "rpc"` and which was
  started with `REMBRIC_TRACK_SESSION=1`
- **WHEN** the full lifecycle fires — `before_agent_start`, `agent_settled` and
  `session_shutdown` with a terminal reason
- **THEN** the session row is created, summarised and ended exactly as the other
  requirements of this capability pin

#### Scenario: Interactive sessions keep their row

- **GIVEN** a pi process whose host context reports `ctx.mode === "tui"` and which was
  started with none of the markers above
- **WHEN** the full lifecycle fires
- **THEN** the session row is created and ended exactly as the other requirements of
  this capability pin

#### Scenario: Rembric tools stay available inside a suppressed process

- **GIVEN** a pi process that would be suppressed under any rule above
- **WHEN** `session_start` completes
- **THEN** the server's tools are registered exactly as in a primary session
- **AND** a proxied `memory.save` call reaches the database

#### Scenario: A suppressed process issues no MCP identity declaration

- **GIVEN** a pi process that would be suppressed under any rule above
- **WHEN** `before_agent_start` fires
- **THEN** no `memory.session_resume` call is made on the MCP transport
