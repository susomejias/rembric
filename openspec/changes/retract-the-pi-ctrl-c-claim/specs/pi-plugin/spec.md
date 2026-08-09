# pi-plugin — delta for retract-the-pi-ctrl-c-claim

## REMOVED Requirements

### Requirement: Session close is awaited, with the interrupt exception recorded

**Reason**: The requirement's own scenario `Ctrl-C is documented as lossy in both modes` states a falsehood in its **title**, and a `MODIFIED` block cannot rename a published scenario title — `check-delta-freshness` fails on the missing title and `openspec archive` refuses the merge. `REMOVED` + `ADDED` is the only mechanism that renames one, and `openspec validate` rejects that pair unless the requirement header changes too. The header was going to need replacing regardless: "the interrupt exception" is singular, and what survives is a set of exit paths of two different evidence grades.

**Migration**: Replaced by "Session close is awaited, and each exit path is named with the evidence for it", which carries all five surviving scenarios byte-identical and replaces the sixth with one whose title is not itself a claim. The interrupt exception is **narrowed, not removed**: a single Ctrl-C press, print-mode SIGINT and SIGKILL still reach no handler. What is retracted is the interactive half of "in either mode" — measured against Pi 0.84.1, two presses within 500 ms run the same awaited `shutdown()` Ctrl-D runs and emit `reason: "quit"`, which `apps/plugin/.pi-plugin/index.ts:72` already treats as closing. No client behaviour changes and no operator action is required; the replacement also labels the print-mode claim as a source read rather than a measurement.

## ADDED Requirements

### Requirement: Session close is awaited, and each exit path is named with the evidence for it

The harness awaits its session-shutdown handler without a timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the control — SIGKILL — runs nothing). This client SHALL therefore perform its final session flush as an **awaited** call and SHALL NOT use the fire-and-forget dispose flush the opencode client requires.

On a shutdown whose reason closes the session (see "The shutdown reason decides whether the session is ended"), that awaited call SHALL be **one** request: `POST /api/<slug>/sessions/<id>/end` with body `{summary, title, final:false}` built by the same summary-body builder the per-turn flush uses, or `{}` when that builder yields nothing because the transcript accumulator is empty. On a shutdown that does not close the session it SHALL remain the summary POST it is today.

The end SHALL NOT be split into a summary POST followed by an end POST. Because the handler is awaited, the risk this design manages is **exit latency**, not a dropped write: every POST is bounded by `POST_TIMEOUT_MS`, so two sequential POSTs double the worst case a quitting user waits on an unreachable server and exceed the teardown budget this capability's tests assert. One request also removes the question of what a half-completed pair means, and matches `apps/plugin/scripts/session-end.sh`, the one shutdown path in this repository with production mileage.

The end SHALL be the last write this client makes for that session. Precedence is asymmetric across the terminal boundary — active rows are last-final-wins, terminal rows are first-final-wins (see the `sessions` capability) — so a curated `memory.session_summary` arriving after an end is silently dropped. A client SHALL NOT end a session it may still write to.

The shared core SHALL expose both the awaited flush and the fire-and-forget variant so each client uses the one its host's shutdown semantics justify. Copying the fire-and-forget path into this client would discard a measured guarantee for symmetry alone and SHALL NOT be done.

**Two Ctrl-C presses within 500 ms DO close the session, and no surface SHALL state otherwise.** In the interactive TUI, with the prompt focused and on the default `app.clear` binding, `handleCtrlC()` calls the same `void this.shutdown()` that `handleCtrlD()` calls when `now - this.lastSigintTime < 500` (`dist/modes/interactive/interactive-mode.js:3048-3059`); `shutdown()` awaits `runtimeHost.dispose()` before `process.exit(0)` (`:3100`). The emitted reason is `quit`, already in this client's end-set, so the session ends correctly with no code change. Pi advertises the key itself in its startup banner (`:667`, `${keyText("app.clear")} twice` "to exit").

Measured against 0.84.1 under `script -q` with timed stdin, `HOME` redirected and no server running, recording `Date.now()-t0` on `session_shutdown`:

| Arm                                        | `session_shutdown` fired at | Reason |
| ------------------------------------------ | --------------------------- | ------ |
| No keys at all (baseline — stdin EOF only) | 10577 ms                    | `quit` |
| Two Ctrl-C 200 ms apart                    | **5809 ms**                 | `quit` |
| Two Ctrl-C 1500 ms apart                   | 11839 ms                    | `quit` |

The 200 ms arm fires ~4.8 s before anything the baseline can produce, so only the key explains it; 11839 − 10577 ≈ the 1300 ms of extra key spacing, which is the table checking itself. **`reason` cannot discriminate and never could** — every arm reports `quit`, because the EOF exit and the key exit both terminate through `runtimeHost.dispose()` — so a probe asserting the reason, or merely that the handler ran, passes on the baseline too. Only elapsed time discriminates, and any future re-measurement SHALL be timed against a no-keys baseline.

All three qualifiers above are load-bearing and SHALL be carried wherever this is documented: **twice within 500 ms** (`:3048`'s guard), **in the interactive TUI with the prompt focused** (the handler binds to the default editor, `:2223`; an overlay routes the key elsewhere and is unmeasured), and **on the default binding** (`dist/core/keybindings.js:8`, user-rebindable).

**The exits that reach no handler, each stated with its evidence grade:**

- **A single Ctrl-C press, or two spaced beyond the window** (measured): the 1500 ms arm above lands at the stdin EOF, so the key contributed nothing. A single press clears the editor and arms the window; it SHALL NOT be documented as exiting.
- **Print-mode SIGINT** (**source read, not executed**): `dist/modes/print-mode.js:32-44` registers `["SIGTERM"]` plus SIGHUP, and `SIGINT` appears nowhere in that file. This claim is labelled rather than presented as measured, because three attempts to execute it failed their control arm and were discarded — inside a requirement whose interactive half was overturned by a run, an unexecuted read SHALL NOT be presented as a measurement.
- **SIGKILL and OS-level crashes** (measured — the discriminating control below).

For those paths the per-turn flush bounds the **summary** loss at one turn. It bounds nothing about `status`: a process that reaches no handler leaves its row `active` until the server's stale-active sweep retires it as `abandoned`, and no flush changes that.

#### Scenario: Shutdown flush completes

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down via its normal exit path or SIGTERM
- **THEN** the summary POST SHALL complete before the process exits
- **AND** the server SHALL hold a non-null summary for that session

#### Scenario: The closing shutdown issues exactly one request

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL issue exactly one session-write request, to the end path, carrying the accumulated summary and derived title with `final:false`
- **AND** it SHALL NOT also issue a request to the summary path for that session

#### Scenario: An empty transcript still ends the session

- **GIVEN** a registered session whose transcript accumulator is empty
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL POST the end path with an empty JSON body
- **AND** the row SHALL have `status = 'ended'` with `summary` still null

#### Scenario: The teardown budget holds against an unreachable server

- **GIVEN** a server that accepts connections and never answers
- **WHEN** the harness shuts the session down with `reason: "quit"`
- **THEN** the elapsed teardown SHALL stay within the budget this capability's test asserts, measured as the end-to-end handler wall-clock rather than the timing of the request in isolation

#### Scenario: SIGKILL runs nothing (the discriminating control)

- **WHEN** the process receives SIGKILL
- **THEN** no shutdown handler SHALL run and no summary POST SHALL be issued

#### Scenario: The interrupt is documented by what was measured, not by mode

- **WHEN** the extension's README, the client documentation, or the plugin-development skill describes session capture or how to exit
- **THEN** it SHALL state that in the interactive TUI two Ctrl-C presses within 500 ms run the same awaited shutdown that Ctrl-D runs, so the session is closed and nothing beyond the current turn is at risk
- **AND** it SHALL carry all three qualifiers — twice within 500 ms, interactive TUI with the prompt focused, default binding
- **AND** it SHALL NOT state that a single Ctrl-C press exits, nor that an interrupt fails to close the session in the interactive TUI
- **AND** where it names print-mode SIGINT it SHALL attribute that to Pi's source rather than to a measurement

#### Scenario: No operator surface attributes a lost turn to an interactive Ctrl-C

- **WHEN** a troubleshooting entry explains a session whose last turn is missing, or a session row with no summary
- **THEN** the cause it names SHALL be one of the exits measured or read to reach no handler — SIGKILL, an OS-level crash, or an interrupted print-mode run
- **AND** it SHALL NOT name a Ctrl-C in the interactive TUI as the cause
- **AND** it SHALL NOT name a cause for which this capability records no evidence
