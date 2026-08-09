# plugin-session-protocol — delta for retract-the-pi-ctrl-c-claim

## MODIFIED Requirements

### Requirement: Sessions under the Pi client MUST converge on a non-null summary

Every closed session created by the Pi client SHALL end with a non-null `sessions.summary` whenever **either** of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point, or
- the harness's session-shutdown handler ran with a non-empty per-session transcript accumulator.

The second condition SHALL hold for **every** shutdown reason, and it is not the same request in both cases. On a reason that closes the session the awaited POST is `/end` carrying `{summary, title, final:false}`; on `reload`, on a self-resume, and on an unrecognised reason it is `/summary` with the same body. Convergence is therefore independent of the reason gate: whichever branch the gate selects, the accumulated transcript is written by one awaited request. The reason gate decides `status`, never `summary` — its contract lives in the `pi-plugin` capability.

An empty accumulator does NOT converge and is not expected to: on a closing reason the client POSTs `/end` with an empty body, so the row reaches `'ended'` with `summary` still `NULL`. That is a session with nothing in it, and the dashboard surfaces it as "no summary captured" exactly as for the other degenerate cases.

The second condition is a stronger guarantee than the equivalent opencode condition, and the difference is measured rather than assumed. The harness awaits its shutdown handler with no timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the discriminating control — SIGKILL — runs nothing). So this client's final flush is an **awaited** POST and its landing is a guarantee, not a race, whereas the opencode dispose-time flush is explicitly best-effort because that host kills the subprocess before async handlers finish.

A per-turn debounced flush SHALL also run, as for the other in-process clients, so the server's summary is current at all times and any loss is bounded to one turn.

**The exception is narrower than this capability first published, and is stated per exit path.** In the interactive TUI an interrupt **does** reach the handler when it is pressed twice within 500 ms: measured against 0.84.1 with timed stdin, that arm fired `session_shutdown` at **5809 ms** against a no-keys stdin-EOF baseline of **10577 ms**, so the session converges exactly as it does on Ctrl-D. Two presses 1500 ms apart landed at **11839 ms** — the EOF — so a single press still reaches nothing. The full measurement, the three qualifiers it depends on, and the retraction of the earlier "in either mode" reading live in the `pi-plugin` capability and are not restated here.

What remains out of scope for convergence, in exactly the way a hard crash already is: a single interrupt press followed by a kill, print-mode SIGINT (read from `dist/modes/print-mode.js:32-44`, which registers `["SIGTERM"]` plus SIGHUP — a source read, not an executed measurement), and SIGKILL. For those the per-turn flush bounds the summary loss to one turn, and the row stays `active` until the stale-active sweep retires it.

#### Scenario: Cooperating agent

- **GIVEN** a Pi session in which the agent called `memory.session_summary({summary, title})`
- **WHEN** the session ends
- **THEN** `sessions.summary` SHALL be the model-authored content
- **AND** it SHALL NOT be overwritten by the shutdown flush (which POSTs with `final:false`)

#### Scenario: Non-cooperating agent, normal shutdown

- **GIVEN** a Pi session with at least one user turn and no `memory.session_summary` call
- **WHEN** the harness shuts the session down through its normal exit path or SIGTERM
- **THEN** the awaited POST carrying the accumulated transcript SHALL complete before the process exits — `/end` because that reason closes the session
- **AND** `sessions.summary` SHALL be non-null
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: A reload converges without ending the session

- **GIVEN** a Pi session with at least one user turn and no `memory.session_summary` call
- **WHEN** `session_shutdown` fires with `reason: "reload"`
- **THEN** the awaited POST SHALL be `/summary`, not `/end`
- **AND** `sessions.summary` SHALL be non-null
- **AND** `sessions.status` SHALL still be `'active'`

#### Scenario: SIGKILL loses the final flush (the discriminating control)

- **GIVEN** a Pi session with accumulated transcript entries
- **WHEN** the process is SIGKILLed
- **THEN** no shutdown handler SHALL run
- **AND** convergence SHALL rest on the last per-turn flush, so the stored summary SHALL lag by at most one turn
