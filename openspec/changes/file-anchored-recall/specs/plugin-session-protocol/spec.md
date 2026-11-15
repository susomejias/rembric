## ADDED Requirements

### Requirement: Every client MUST ask for file-anchored recall when the agent reaches a file, the same way

Each client SHALL call `POST /api/<slug>/sessions/<id>/file-recall` (`http-api`) for the files the agent reads or edits, and SHALL put the returned lines in front of the model. The mechanism differs per host only where the host forces it:

| Client | Where the path is captured | How the lines reach the model |
|---|---|---|
| Claude Code | `PreToolUse` on `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash` | `hookSpecificOutput.additionalContext`, documented as "added to Claude's context alongside the tool result" |
| Codex CLI | `PreToolUse` on `Bash`, `apply_patch` | `hookSpecificOutput.additionalContext`, recorded as a developer message |
| Pi | `tool_call` | appended as a text block to that call's `tool_result` content |
| Hermes Agent | `transform_tool_result` (file tools) / `transform_terminal_output` (terminal) | appended to that tool's result |
| opencode (v2 plugin API only) | `ctx.tool.hook("execute.before")` | `ctx.session.hook("context")` system push on the next request |

On every host the model sees the note at its next step, together with or right after the tool's result:
- **For a read,** that is the moment the file's content arrives, which is the point of the feature.
- **For an edit,** the note can only shape the steps that follow the edit. This spec does not promise more.

The rules below hold for every client. Each one is verified per client against that host's official documentation at the version the client targets.

**Path extraction**
- For a file tool, the path SHALL be the tool's own file-path argument.
- For a shell command, the paths SHALL be the path-like tokens of the command, as pinned by the shared fixture `apps/plugin/test/file-recall-fixtures.json`, capped at 5 per command. A path-like token is a token containing `/` and ending in a `.<extension>`, or an absolute path. This works whatever the command is (`cat`, `sed`, `grep`, `rg`, `git show`, `rtk …`), so no list of commands is maintained.
- For Codex `apply_patch`, the paths SHALL be those named on `*** Add File:`, `*** Update File:` and `*** Delete File:` lines.

**Path normalisation**
- Each path SHALL be resolved against the working directory the host reports, and made relative to that directory's git top-level.
- It SHALL be kept only if it names one regular file the repository tracks, matched literally: a directory, a glob, or a bracketed route name such as `app/[id]/page.ts` SHALL never stand in for another file. Non-ASCII names SHALL be sent as themselves, never C-quoted. Nothing outside the repository is ever sent.

**Siblings:** the client SHALL list the tracked paths sharing the file name (`git ls-files -- '*/<name>' '<name>'`). It SHALL send them as `siblings` only when there are at most 64; otherwise it SHALL send none.

**Once per file:** each client SHALL remember, per session, the paths it has already sent and SHALL NOT send one again. Once a response carries `exhausted: true`, it SHALL send nothing more for that session.

**Bounded and fail-open**
- Each client SHALL bound the call: 0.3 s for the bash hook's POST, 500 ms for the JavaScript core, 0.5 s for Hermes. Every host-level hook timeout SHALL sit above that budget. After the first failed request in one firing, a client SHALL send nothing more in that firing.
- A timeout, a non-2xx response (an older server answers `404`), a non-repository directory, a missing `git`, or any parse failure SHALL produce no output. It SHALL NEVER block, deny or fail the tool.

**Sub-agents:** sub-agent tool calls SHALL be skipped, exactly as prompt-time recall skips sub-agent sessions, so the parent session's dedupe is not spent on a context the parent never sees.

#### Scenario: The same read yields the same note on every client

- **GIVEN** an eligible memory linked to `packages/db/src/migrate.ts` and a fresh session on each of the five clients
- **WHEN** the agent reads that file, through the host's file tool where it has one and through `cat packages/db/src/migrate.ts` otherwise
- **THEN** each client SHALL deliver the same rendered block to the model once
- **AND** a second read of the file in the same session SHALL deliver nothing and SHALL issue no request

#### Scenario: A shell command's paths are extracted by one rule

- **WHEN** the extractor of each language (bash, JavaScript, Python) runs over every command in `file-recall-fixtures.json`
- **THEN** each SHALL produce exactly the fixture's expected path list
- **AND** a fixture covering `rtk read <path>`, `rg -n x <path>`, `git show HEAD:<path>` and `sed -n 1,20p <path>` SHALL be present

#### Scenario: The client never sends a path outside the repository

- **WHEN** the agent runs `cat /tmp/notes.txt ../other-repo/x.ts`
- **THEN** no request SHALL be issued

#### Scenario: Failure leaves the tool untouched

- **GIVEN** a server that does not answer within the client's budget, or answers `404`
- **WHEN** the agent reads a file
- **THEN** the tool SHALL run normally and the client SHALL emit no model-visible output
- **AND** the hook or handler SHALL complete within its budget plus process overhead

### Requirement: The shared JavaScript core MUST own the file-recall call and the shell-path extractor

`apps/plugin/bin/rembric-plugin-core.mjs` SHALL be the single JavaScript implementation, typed in `rembric-plugin-core.d.mts`, of:
- `fileRecall(sessionId, path, siblings)`, which POSTs to the endpoint;
- `extractCommandPaths(command)`, the shell-path extractor;
- the per-session record of paths already sent and of exhaustion.

Pi and opencode SHALL import them and SHALL NOT re-implement any of them. Every per-session container the core adds SHALL be cleared in `forgetSession`.

Bash (`apps/plugin/scripts/_api.sh`) and Python (`apps/plugin/.hermes-plugin/__init__.py`) keep their own extractors, by the repository's cross-language rule. They SHALL agree with the core on every fixture in `file-recall-fixtures.json`.

#### Scenario: Pi and opencode use the core's call

- **WHEN** `apps/plugin/.pi-plugin/index.ts` and `apps/plugin/.opencode-plugin/plugin.ts` are read
- **THEN** both SHALL import `fileRecall` and `extractCommandPaths` from `rembric-plugin-core.mjs`
- **AND** neither SHALL define a function with either name

#### Scenario: Forgetting a session clears its file-recall state

- **GIVEN** a session that has sent two paths and been told `exhausted: true`
- **WHEN** `forgetSession` runs for it
- **THEN** a new session with the same id SHALL be free to send both paths again

## MODIFIED Requirements

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations. Read-only per-tool calls — file-anchored recall (`POST /sessions/<id>/file-recall`) — are not lifecycle writes and are mapped by their own requirement in this capability, not by this table.

| Client      | Lifecycle event                                                         | HTTP call                                                                                                                                                    | `final` |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear\|fork`)                         | `POST /sessions {id, cwd, agent}` (placeholder title) **then `POST /sessions/<id>/resume`**                                                                  | n/a     |
| Claude Code | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Claude Code | `UserPromptSubmit`                                                      | none (stdout lines only — local lines plus the cached notice)                                                                                                | n/a     |
| Claude Code | `Stop` (every turn)                                                     | `POST /sessions/<id>/turn {usedTools, title?}` — the response's `lines` are cached, never printed here                                                       | n/a     |
| Claude Code | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Claude Code | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Claude Code | `SessionEnd`                                                            | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)                               | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Codex CLI   | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Codex CLI   | `UserPromptSubmit`                                                      | none (stdout lines only — local lines plus the cached notice)                                                                                                | n/a     |
| Codex CLI   | `Stop` (every turn)                                                     | `POST /sessions/<id>/turn {usedTools, title?}` + stdout `'{}'` — the response's `lines` are cached, never printed here                                       | n/a     |
| Codex CLI   | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Codex CLI   | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Codex CLI   | `SessionEnd` (main thread only)                                         | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Hermes      | `initialize`                                                            | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Hermes      | `on_pre_compress(messages)`                                             | `POST /summary {summary, final:false}`                                                                                                                       | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`                                  | `POST /end old` (only when the id actually changed) `+ POST /sessions new` **then `POST /sessions/new/resume`** on the first ensure of `new` in this process | n/a     |
| Hermes      | `sync_turn(user, assistant, **kwargs)`                                  | `POST /sessions/<id>/turn {usedTools, title?}` on a background thread; the response's `lines` are cached for the next `prefetch()`                           | n/a     |
| Hermes      | `on_session_end(messages)`                                              | `POST /end {summary, title, final:false}`                                                                                                                    | false   |
| opencode    | `session.created` (not a sub-agent)                                     | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| opencode    | `chat.message`                                                          | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + cached notice and local lines pushed           | n/a     |
| opencode    | `session.idle`                                                          | `POST /sessions/<id>/turn {usedTools, title?}`; the response's `lines` are cached for the next `chat.message`                                                | n/a     |
| opencode    | `session.compacted`                                                     | `POST /summary {summary, title?, final:false}`                                                                                                               | false   |
| opencode    | `experimental.session.compacting`                                       | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; + injected context                                                 | n/a     |
| opencode    | `session.deleted`                                                       | none (drops the in-memory accumulator only)                                                                                                                  | n/a     |
| opencode    | `server.instance.disposed`                                              | fire-and-forget `POST /summary {summary, title?, final:false}` per known session — never `/end`                                                              | false   |
| Pi          | `session_start`                                                         | none (creates the protocol client and discovers tools over MCP)                                                                                              | n/a     |
| Pi          | `before_agent_start`                                                    | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`** on the first ensure of the id in this process; + cached notice and local lines       | n/a     |
| Pi          | `message_end`                                                           | none (feeds the in-memory accumulator and the turn's tool observation only)                                                                                  | n/a     |
| Pi          | `agent_settled`                                                         | `POST /sessions/<id>/turn {usedTools, title?}`; the response's `lines` are cached for the next `before_agent_start`                                          | n/a     |
| Pi          | `session_shutdown` (`quit\|new\|resume\|fork`, not a self-resume)       | `POST /end {summary, title, final:false}`, or `{}` when the accumulator is empty                                                                             | false   |
| Pi          | `session_shutdown` (`reload`, a self-resume, or an unrecognised reason) | `POST /summary {summary, title?, final:false}` — never `/end`                                                                                                | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP)                       | internal write (no HTTP) with `final:true`                                                                                                                   | true    |

**Every client SHALL issue exactly one `POST /api/<slug>/sessions/<id>/resume` per session id per process, immediately after the FIRST `POST /api/<slug>/sessions` ensure for that id in that process, and SHALL NOT condition it on any host signal.** This is the one uniform rule; there is no per-client variation in when the call is made, and a client SHALL NOT gate it on a `source`, `reason` or `reset` value.

Three properties make the unconditional form the correct one rather than a shortcut:

- **The resume is a documented no-op on an `active` row** (`http-api` capability), so on a genuinely new session the call changes nothing and costs one local request. The client therefore does not need to know whether it is resuming, which is fortunate, because —
- **no client has a resume signal on a cold start**, and a cold start is the case that motivates the rule. Claude Code and Codex CLI do expose `source: "resume"` on `SessionStart`, and Hermes exposes `reason="resume"` with `reset=False` on `on_session_switch`, but those fire for session changes **inside a living process**, where the client's own in-memory state already keeps attribution correct. Pi's cold-start resume arrives as `reason: "startup"`, indistinguishable from a clean start. Building the emitter on those signals would produce a per-client asymmetry that still failed the case it was built for.
- **The ordering is ensure-then-resume, and it is load-bearing.** A session whose row was physically purged by `purgeEmpty` (permitted once a terminal row's grace elapses with no memories attached) is recreated `active` by the ensure, and the resume that follows is then a no-op against the row the ensure just created. The conversation continues under the same id with no special case. Reversing the order would resume a row that does not exist and report `session_not_found` for a conversation that is about to be perfectly healthy.

The rule replaces a recovery two clients already attempt and provably cannot perform: `post-compact.sh`'s ensure carries the comment "covers the case where the row was abandoned by the stale sweep between the pre-compact moment and the post-compact resume — re-create silently", and the ensure path returns a terminal row untouched (`http-api` capability). Before this rule that comment described behaviour that did not exist.

**Every client SHALL issue exactly one `POST /api/<slug>/sessions/<id>/turn` per finished turn**, on its own end-of-turn event, and SHALL NOT issue it on a start-of-turn event. That is the row that replaces the per-turn `POST /summary` the shell clients previously performed on `Stop`, and it carries the obligations that write used to carry: it is what advances `last_activity_at`, so a live session is not retired by the stale-active sweep, and it is what delivers the provisional title. The clients that also flush a transcript at a MILESTONE — opencode's `session.compacted` and dispose, Pi's shutdown, Hermes's `on_pre_compress` and `on_session_end`, the shell clients' `PreCompact` and `SessionEnd` — keep those rows unchanged; only the PER-TURN raw sync is replaced.

**"Finished" is load-bearing in that sentence, and exactly one client cannot satisfy it on every turn.** Hermes reports from `sync_turn`, which its host does not call at all on an interrupted turn — the memory fan-out returns first. So a Hermes turn the user interrupts yields no report and therefore no `last_activity_at` stamp. That deviation is permitted, is specified with its consequence in `hermes-agent-plugin`, and SHALL NOT be worked around client-side by reporting from a start-of-turn handler or a timer: a report is a statement that a turn finished, and issuing one for a turn that did not would corrupt the only signal this endpoint carries. Any client added later that cannot observe turn completion SHALL be documented the same way rather than made to approximate it.

Seven rows are load-bearing and easy to get wrong:

- **The shell clients no longer POST a transcript on `Stop`.** `apps/plugin/scripts/stop-sync.sh` is deleted. The per-turn body it sent was re-derived from a JSONL file the host already persists and which `pre-compact.sh` and `session-end.sh` re-read anyway; what is lost is the case of a session hard-killed between two terminal events, which now stores nothing in Rembric rather than the previous turn's transcript. That exposure is a SIGKILL, and it is the same class of loss this capability already documents as out of scope for opencode and Pi.
- **The in-process clients' transcript accumulator and terminal flushes are UNCHANGED.** opencode's dispose flush and Pi's shutdown POST hold the only copy of those sessions' transcripts, and both convergence guarantees in this capability rest on them. The turn report does not replace them and SHALL NOT be read as doing so.
- **`SessionStart (compact)` does make HTTP calls on both shell clients.** `post-compact.sh` re-POSTs `/sessions` and then `/sessions/<id>/resume` before emitting its stdout block, which is additionally injected into the resumed model's context.
- **Claude Code's `SessionStart` matcher group includes `fork`.** A forked session reports `source: "fork"` from v2.1.214 onward and carries a NEW session id, so it is a new session that must be registered. Codex's `SessionStart` has no `fork` source — its documented values are `startup`, `resume`, `clear` and `compact` — so its matcher group SHALL NOT declare one, and the asymmetry is the hosts', not ours.
- **Codex CLI DOES have `SessionEnd`.** It runs for the main thread when an open conversation is archived or deleted, when Codex closes normally, or after 30 minutes idle with no connected client, and it does not run for subagents. Its time budget is the tightest of any hook on either host: **1 second by default, 3 seconds maximum**, where every other Codex hook defaults to 600. A handler that does not declare `"timeout": 3` is killed after one second, and a POST allowed to consume that whole budget leaves nothing for reading the transcript or emitting the failure diagnostic.
- **Pi's two `session_shutdown` rows are selected by the event's `reason`, and the split is the whole point.** `reason: "reload"` is the same session continuing; ending there costs `session_id = NULL` on every later write until the next `before_agent_start` ensure-and-resume repairs it. A `resume` that names the session file already open is the same hazard under a different reason. Pi is the only client that chooses its shutdown endpoint at runtime.
- **opencode's dispose row is fire-and-forget and never `/end`, by decision rather than omission.** The host kills the subprocess before async handlers settle, so an awaited call there would frequently not land and no requirement could promise `ended`. An opencode row therefore stays `active` until `abandonStale` flips it.

Of the five clients, four POST `/end`: Claude Code, Codex CLI, Hermes and Pi. opencode does not, for the reason above, and its rows reach `abandoned` through the sweep. All five POST the resume, and all five POST the turn report.

#### Scenario: Every client has a row and no client has an undocumented lifecycle write

- **WHEN** the table above is compared against the shipped clients at HEAD
- **THEN** each of the five clients SHALL have at least one row
- **AND** every lifecycle handler in each client that issues an HTTP request SHALL correspond to a row naming that endpoint
- **AND** a handler that issues no request SHALL either be absent from the table or carry `none` in the HTTP-call column

#### Scenario: Every client reports exactly one turn per turn

- **GIVEN** any of the five clients driven through three consecutive turns, all of which the user allows to finish
- **WHEN** the requests it issues are recorded
- **THEN** exactly three `POST /api/<slug>/sessions/<id>/turn` requests SHALL have been made
- **AND** none SHALL have been made from a start-of-turn event

#### Scenario: A turn the host never finishes is not reported, and is not faked

- **GIVEN** a Hermes session in which the middle of three turns is interrupted
- **WHEN** the requests are recorded
- **THEN** exactly two reports SHALL have been made
- **AND** no report SHALL have been synthesised for the interrupted turn from a start-of-turn handler, a timer, or any other substitute

#### Scenario: No shell client POSTs a transcript per turn

- **WHEN** `apps/plugin/scripts/` is read at HEAD
- **THEN** `stop-sync.sh` SHALL NOT exist
- **AND** no script wired to the `Stop` event SHALL POST to `/summary`

#### Scenario: Every client resumes exactly once per session id per process

- **GIVEN** any of the five clients, running against a session id `<S>` whose row is `ended`
- **WHEN** the client performs its first `POST /sessions` ensure for `<S>` in that process
- **THEN** it SHALL immediately POST `/api/<slug>/sessions/<S>/resume`
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL` afterwards
- **AND** every subsequent ensure of `<S>` in the same process SHALL NOT POST the resume again
- **AND** the control SHALL pass in the same run: a client whose first ensure is for a session id with no prior row SHALL still POST the resume, and it SHALL succeed as a no-op with `previousStatus: 'active'`

#### Scenario: The resume is not conditioned on a host signal

- **WHEN** each client's ensure path is read at HEAD
- **THEN** no client SHALL branch its resume call on `source`, `reason`, `reset`, `rewound`, or any other host-supplied indication of whether the conversation is new
- **AND** removing every such field from the host payload SHALL leave the resume behaviour unchanged

#### Scenario: A failed resume degrades to a diagnostic, never to an aborted session

- **GIVEN** a client whose server returns `404 session_not_found` for the resume (an id the server has never seen under this token)
- **WHEN** the ensure-then-resume pair runs
- **THEN** the client SHALL emit exactly one stderr diagnostic naming the path and status, per this capability's failed-POST requirement
- **AND** the host session SHALL continue, and the hook or handler SHALL exit successfully

#### Scenario: A failed turn report degrades to a diagnostic, never to an aborted session

- **GIVEN** a client whose server returns `404` for the turn report (an old server that does not implement the route)
- **WHEN** the end-of-turn handler runs
- **THEN** the client SHALL emit exactly one stderr diagnostic naming the path and status, per this capability's failed-POST requirement
- **AND** it SHALL cache no lines and SHALL NOT clear any pending ones
- **AND** the host session SHALL continue, and the hook or handler SHALL exit successfully

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these seven event types and no others: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear|fork` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly three entries, none carrying a `matcher` key
- **AND** `PreToolUse` SHALL declare exactly ONE entry, matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Bash`, invoking `file-recall.sh claude-code`
- **AND** `Stop` SHALL declare exactly ONE entry, invoking `stop-report.sh`, and it SHALL NOT declare `async` — an asynchronous handler is fire-and-forget by the host's contract and could not deliver a response the next turn depends on
- **AND** the seven event types SHALL carry ten handler entries in total
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these seven event types and no others: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact` — Codex has no `fork` source, so unlike Claude Code's manifest this group SHALL NOT declare one
- **AND** `UserPromptSubmit` SHALL declare exactly three entries, none carrying a `matcher` key
- **AND** `PreToolUse` SHALL declare exactly ONE entry, matcher `Bash|apply_patch`, invoking `file-recall.sh codex-cli`
- **AND** `Stop` SHALL declare exactly ONE entry
- **AND** the seven event types SHALL carry ten handler entries in total
- **AND** the `SessionEnd` entry SHALL declare `"timeout": 3`, the documented maximum for this one event, and SHALL carry no `matcher` key
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: `pre-compact.sh` exists and is wired on both clients

- **WHEN** the repository is inspected at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh` SHALL exist and be executable
- **AND** `hooks.json`'s `PreCompact` entry SHALL invoke it with the agent argument `claude-code`
- **AND** `hooks.codex.json`'s `PreCompact` entry SHALL invoke it with the agent argument `codex-cli`

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, `on_session_switch` and `sync_turn`
