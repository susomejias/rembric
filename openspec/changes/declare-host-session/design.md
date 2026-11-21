## Context

See `proposal.md`. This document is the contract that the server, the JavaScript side (bridge, opencode, Pi) and the shell/Python side (Claude Code and Codex hooks, Hermes) implement independently. Every decision here is normative for all three.

## Decisions

### D1. The header

- Name: `X-Rembric-Session`. Value: a session id matching `^[A-Za-z0-9_-]{8,128}$`, the same pattern `POST /api/<slug>/sessions` enforces on `id`.
- Clients send it on every MCP HTTP request, `initialize` included, whenever they know the host session. They never send it empty.
- The server reads it in the MCP route, alongside `X-Rembric-Repo-Fingerprint`, into `RequestContext.declaredSessionId`. A missing or malformed value leaves the field `undefined`, and the server answers no error for it: a session declaration is attribution metadata, never authority.

### D2. When the server honours it

The declared session is **honoured** only when all of these hold, checked at resolution time:

- the row exists;
- its `token_id` equals the request token's id;
- its `project_id` equals the connection's resolved project id;
- `status = 'active'`;
- `deleted_at IS NULL`.

Otherwise the declaration is ignored exactly as if absent. Not erroring is deliberate. A stale declaration (the host's previous session after `/clear`, or a session the sweep abandoned) must degrade to today's behaviour, never refuse a write. Requiring `active` is what keeps a stale declaration from attaching new writes to a closed session.

### D3. Precedence (the host wins)

For `memory.save`, `memory.confirm`, `memory.merge`, `memory.save_prompt`, `memory.capture_passive`, `memory.session_summary`, `memory.session_end`, and the focus seed of `memory.context`:

1. An honoured declared session. The tool's `sessionId` argument is ignored entirely, without even an ownership check, because the host's identity outranks the model's.
2. Otherwise the explicit `sessionId` argument, ownership-checked exactly as today.
3. Otherwise `findActiveForTransport` (sole active). `memory.session_summary` and `memory.session_end` classify the unresolved case through `resolveForTransport` (`session_ambiguous` or `session_not_found`), as `report-session-ambiguity` specifies.

`memory.session_start`: an honoured declared session is adopted before step (1) of its published order, reporting `reused: true` with that row's `agent`.

`memory.session_resume`: unchanged. Its explicit `sessionId` is required and wins, because naming the session is the tool's whole purpose.

One helper owns steps 1–2 (in `packages/mcp/src/_shared.ts`), and every listed handler calls it. No handler re-implements the check.

### D4. Host binding file

- **Directory:** `<home>/.cache/rembric/host-sessions/`, where `<home>` is the OS user's home directory:
  - Node: `os.homedir()`, which falls back to the passwd entry when `HOME` is unset (Codex clears the bridge's environment).
  - Bash: `$HOME`.
  - Python: `os.path.expanduser('~')`.
  - Mode `0700`, created on demand.
  - Not `~/.rembric/`, which can hold a local server's data directory.
  - `XDG_*` and `TMPDIR` are deliberately ignored, because the bridge and the hooks do not share an environment.
- **File:** `<pid>.json`, mode `0600`, written atomically (temporary file in the same directory, then rename).
- **Content:** exactly `{"pid": <integer>, "start": "<start token>", "sessionId": "<session id>"}`. Readers ignore extra keys.
- **Start token:** the trimmed stdout of `ps -o lstart= -p <pid>`, run with `LC_ALL=C` and runs of whitespace collapsed to one space. Every writer and reader uses exactly this. The fixed locale matters because the bridge and the hooks do not share an environment. If `ps` fails or prints nothing, the writer publishes nothing and the reader treats that ancestor as unbound.
- **Platform:** on `win32` nobody publishes and the bridge looks nothing up.
- **Pruning:** a publisher MAY delete entries in the directory whose process no longer exists or whose start no longer matches. Readers never delete.

### D5. Who publishes, for which process

- **In-process plugins (opencode, Hermes):** their own process (`process.pid` / `os.getpid()`), because the host spawns the bridge as its descendant.
  - opencode publishes its **root** session id, never a subagent's, matching how it already registers sessions.
  - Each plugin re-publishes when the active session changes, and removes the file at dispose or shutdown only if it still names the session being closed.
- **Hooks (Claude Code, Codex):** `SessionStart` publishes for every source (startup, resume, clear, compact) for the **host process**: the nearest ancestor of the hook process whose command name (`ps -o comm=`, basename) is not one of `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `env`.
  - The hooks are configured as shell-form commands, so a shell may sit between the host and the script.
  - Stopping at the first non-shell ancestor publishes for the host and never for an outer host (one Claude Code launched from another's terminal).
  - `SessionEnd` removes the host's file only when its `sessionId` equals the ending session, so a `/clear` whose new `SessionStart` already published is not undone.
  - Publishing is best-effort and never fails the hook.
- **Pi** does not publish. Its own MCP transport sets `X-Rembric-Session` from the session id it already sends as `sessionId`.

### D6. Bridge lookup

- At startup the bridge records its ancestor chain: parent PID upwards, at most 8 entries, stopping at PID 1. For each it records the start token (D4). This runs once, because a live process's ancestors and their start times do not change.
- On every request it walks that chain nearest-first and reads `<pid>.json`. It takes the first entry whose `pid` and `start` equal the recorded values and whose `sessionId` matches the D1 pattern, and sends `X-Rembric-Session` with that id. No match means no header.
- Reading per request (a small file per ancestor until the first match) is what makes `/clear` take effect without restarting the bridge. Any read or parse error counts as no match for that ancestor.
- The bridge never writes or deletes binding files.

### D7. One implementation per language

- **JavaScript:** a new module `apps/plugin/mcp-bridge/rembric-host-binding.mjs` owns the start token, the directory, publish, remove and lookup. The bridge uses lookup. The opencode plugin imports publish and remove from that canonical path, following the `rembric-dotenv.mjs` pattern.
- **Bash** (`apps/plugin/scripts/_api.sh`) and **Python** (`.hermes-plugin/__init__.py`) carry their own implementations, per the repository's cross-language rule. They must agree byte-for-byte on the directory, file name, JSON keys and start token.
- A shared test fixture should pin all three to the same layout.

## Risks

- **A `/clear` race:** a write sent between the host switching sessions and its hook publishing carries the old id. If the old row is ended, D2 ignores it and today's fallback applies. If it is still `active`, the write attaches to the previous session of the same conversation, which is benign.
- **The ancestor heuristic:** a host started through a non-shell wrapper (for example `timeout claude`) would publish for the wrapper. The bridge's chain still contains it, so the lookup works as long as the wrapper outlives the session.
- **Same-user trust:** binding files are readable only by the user who owns them. A local process running as that user could forge one, but it can already read the API token. And D2 still confines any declared session to the token's own active sessions.
