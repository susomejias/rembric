## ADDED Requirements

### Requirement: Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session

The published bridge knows no session. The client's lifecycle code, which does, SHALL publish a host binding: a file mapping the host process to the session it is running, which the bridge reads to send `X-Rembric-Session` (`mcp-bridge`). Claude Code, Codex CLI, opencode and Hermes Agent publish one; Pi does not, because its own MCP client sends the header (`pi-plugin`).

**Location.** `<home>/.cache/rembric/host-sessions/`, where `<home>` is the OS user's home directory: `os.homedir()` in JavaScript, `$HOME` in bash, `os.path.expanduser('~')` in Python. `XDG_*` and `TMPDIR` SHALL be ignored, because the bridge and the hooks do not share an environment. A writer SHALL create the directory on demand with mode `0700` and SHALL NOT write into a directory another user owns.

**File.** `<pid>.json`, mode `0600`, written atomically: a temporary file in the same directory, then a rename onto `<pid>.json`. Its content SHALL be exactly the JSON object `{"pid":<integer>,"start":"<start token>","sessionId":"<session id>"}`, serialised compactly with the keys in that order, so every writer produces the same bytes for the same binding. Readers ignore extra keys.

**Start token.** The stdout of `ps -o lstart= -p <pid>`, run with `LC_ALL=C`, with every run of whitespace collapsed to one space and the result trimmed. When `ps` exits non-zero, prints nothing, or prints only whitespace, the writer SHALL publish nothing.

**Session id.** A writer SHALL publish only an id matching `^[A-Za-z0-9_-]{8,128}$`, the pattern `POST /api/<slug>/sessions` enforces.

**Which process.** An in-process plugin (opencode, Hermes) publishes for its own process. A hook (Claude Code, Codex) publishes for the host process: the nearest ancestor of the hook process, at most 8 levels up and never PID 1, whose command name (`ps -o comm=`, basename) is not one of `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `env`. Stopping at the first such ancestor publishes for the host and never for an outer host that launched it.

**When.** A client SHALL publish whenever its host starts or switches to a session: every `SessionStart` source for the hooks (startup, resume, clear, fork, compact), and every session start or change for an in-process plugin. A publish replaces the previous binding of the same process.

**Removal.** When a session ends, the client SHALL remove its process's binding only while that binding's `sessionId` equals the ending session, so a newer session that already published (a `/clear`) is not undone. The binding SHALL be taken aside (renamed) before it is compared, and put back with a non-clobbering link when it names another session, so a publish landing during the removal survives.

**Pruning.** A publisher MAY delete other bindings in the directory whose process no longer exists or whose current start token differs from the stored `start`. The bash publisher does so after every publish. Readers never delete.

**Platform.** On Windows (`win32`, and bash under MSYS or Cygwin) nobody publishes.

**Never fail.** Publishing and removal are best-effort. No error, missing `ps`, unwritable home or malformed file SHALL fail a hook, raise into the host, or change any other lifecycle behaviour.

**One layout.** The bash (`apps/plugin/scripts/_api.sh`), Python (`apps/plugin/.hermes-plugin/__init__.py`) and JavaScript (`apps/plugin/mcp-bridge/rembric-host-binding.mjs`) implementations SHALL each be tested against the shared fixture `apps/plugin/test/host-binding-layout.json`, which pins the directory, file name, modes, keys, start command and locale, the session-id pattern and the non-host command names.

#### Scenario: A publish writes the fixture layout

- **GIVEN** a host process `H` whose `LC_ALL=C ps -o lstart= -p H` prints `  Sat Nov 21  9:05:01   2026  `
- **WHEN** a client publishes session `S` for `H`
- **THEN** `<home>/.cache/rembric/host-sessions/` SHALL have mode `0700`
- **AND** `<H>.json` in it SHALL have mode `0600` and contain exactly `{"pid":H,"start":"Sat Nov 21 9:05:01 2026","sessionId":"S"}`
- **AND** no temporary file SHALL remain in the directory

#### Scenario: A hook publishes for the nearest non-shell ancestor

- **GIVEN** a hook whose parent is `sh`, whose grandparent is `bash`, whose next ancestor is a host `codex`, launched from a `zsh` inside an outer host `claude`
- **WHEN** the hook publishes
- **THEN** the binding SHALL be written for the `codex` process only

#### Scenario: Only shells up to PID 1

- **GIVEN** a hook whose only ancestors are shells and then PID 1
- **WHEN** the hook publishes
- **THEN** nothing SHALL be written

#### Scenario: ps fails

- **WHEN** `ps -o lstart=` exits non-zero, even after printing text, or prints only whitespace
- **THEN** no binding SHALL be written
- **AND** the hook SHALL exit 0 with its usual output

#### Scenario: An invalid session id is never published

- **WHEN** a client is asked to publish the id `short`
- **THEN** nothing SHALL be written

#### Scenario: Removal spares a newer session

- **GIVEN** the host's binding names session `S2`
- **WHEN** session `S1` of the same host ends
- **THEN** the binding SHALL still exist and name `S2`

#### Scenario: Removal of the ending session

- **GIVEN** the host's binding names session `S1`
- **WHEN** session `S1` ends
- **THEN** the binding SHALL no longer exist

#### Scenario: Stale bindings are pruned

- **GIVEN** bindings for a live process with a matching start, a live process whose start differs, and a process that no longer exists
- **WHEN** the bash publisher publishes for its host
- **THEN** only the host's binding and the live, matching one SHALL remain
