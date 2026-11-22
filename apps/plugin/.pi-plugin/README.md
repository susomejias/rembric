# Rembric for Pi

Persistent memory for [Pi](https://pi.dev), backed by a self-hosted [Rembric](https://github.com/susomejias/rembric) server: memory tools your agent can call, four slash commands, per-turn nudges, `<private>` redaction and automatic session capture.

The same server and the same project selection as Rembric's Claude Code, Codex CLI, Hermes Agent and opencode clients — one memory store, whichever agent you are in.

Pi ships no MCP client of its own, so this extension holds one: it connects to `${REMBRIC_SERVER_URL}/mcp/<slug>`, asks the server which tools exist, and registers every one of them with Pi. Nothing about the tool surface is written down here, so a server that gains a tool gains it in Pi with no update. The server's usage instructions — the crib-sheet the other four clients receive through their host — are forwarded into the system prompt for each turn of a primary session (never a subagent's). The extension declares **no runtime dependencies**.

## Install

Use the **TUI installer** — the single recommended path. It prepares the server, installs the extension, and handles update and uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
# → Plugins → pi → install
```

### Manual install

```bash
pi install npm:@rembric/pi
```

**Never append a version.** A versioned package spec is treated as pinned, and pinned packages are skipped by `pi update --extensions` and `pi update --all` — the update command reports success and moves you nowhere.

## Configure

Export both variables in the shell you start Pi from. Pi does **not** inject environment variables from its own settings file, so a `settings.json` entry is not an alternative:

```bash
export REMBRIC_SERVER_URL=http://127.0.0.1:8787   # your server, no trailing /mcp
export REMBRIC_API_TOKEN=<token from /dashboard/tokens>
```

The project is selected once, at session start: the nearest `.rembric` up to the git checkout root, then `REMBRIC_PROJECT_SLUG`, then, inside a git repository, the project an admin bound the repository to. A bound repository needs no file. To select a project explicitly, drop a `.rembric` file at the repo root:

```
PROJECT_SLUG=my-app
```

The extension connects to `/mcp/my-app`, so the server pins that project for the whole session and no tool argument can reach another one. Add `.rembric` to your global gitignore if you prefer not to commit it. The full rules are in [How a client selects its project](../../../docs/agents.md#how-a-client-selects-its-project).

Without credentials, the extension disables itself and Pi runs normally. Outside a git repository, without a `.rembric` or `REMBRIC_PROJECT_SLUG`, it does the same. Inside a git repository it never falls back to the default project: an unbound repository gets a warning notification and tools that answer `project_unbound`, and a repository it cannot resolve turns the extension off. Each case is named in a Pi notification, and on stderr.

## Verify

```bash
cd /path/to/a/bound/repo   # or one with a .rembric
pi -p "call memory_stats and show the result"
```

You should see a tool call to `memory_stats` returning your server's counts. Then:

- `/context` — recent memory for this project.
- `/recall <query>` — search prior context.
- `/remember <text>` — save a memory.
- `/summary` — persist an end-of-session summary.

Finally, check `…/dashboard/sessions`: a row for this session with agent `pi`, and a summary once the session ends.

## Update

```bash
pi install npm:@rembric/pi
```

Re-running the unpinned install is the update: it is idempotent, and because the spec carries no version it is also what `pi update --all` will move for you.

For a temporary rollback after a broken release, see the [emergency plugin rollback](../../../docs/agents.md#emergency-plugin-rollback) runbook.

## What you get

- **Every Rembric tool**, discovered from the server at session start and registered under a provider-safe name — the server's `memory.save` is registered as `memory_save`, and the call is issued to the server under its own dotted name. Providers reject a tool name containing a dot outright, rejecting the whole payload with it, so the mapping is not cosmetic. Every name you or the model sees in this client is the underscored one: tool descriptions, slash commands, nudges and the server's own usage instructions are all rewritten to match the registry, so nothing tells the model to call a tool that is not there.
  On a Pi with `tool_search` the nine rarely used tools (`memory_stats`, `memory_doctor`, `memory_about`, `memory_compare`, `memory_merge`, `memory_archive`, `memory_timeline`, `memory_session_get_batch`, `memory_search_prompts`) are registered deferred and `tool_search` is switched on, so their schemas (about 11 KB) leave every request until the model searches for them; on an older Pi every tool stays declared.
- **Four slash commands** — `/context`, `/recall`, `/remember`, `/summary` — the same markdown the other clients ship, not a per-client copy; the packaged copies carry the underscored tool names.
- **Per-turn nudges**, byte-identical to every other Rembric client apart from those tool names: a first-prompt context reminder, a recall reminder when your prompt looks like one, a session-opening line on a new session, and the session-summary reminder the server composes from the session's own state and hands back at the end of each turn.
- **Memories about the file in hand** — when the agent reads, edits or writes a file, or runs a `bash` command that names one (`cat`, `sed`, `grep`, `rg`, `git show`…), the memories linked to that file are appended to that tool's result, at most three per file, each file once per session and at most ten files per session. The lookup starts as the tool starts, so it adds no wait of its own, and any failure leaves the result exactly as the tool produced it.
- **Learnings from subagent reports** — when one of the recognised subagent extensions returns a report to this session, the `## Key Learnings` items in it are saved as memories of this session. Recognised: tools `subagent`, `subagent_run`, `subagent_continue` and `subagent_result`, plus `subagent-notify` and `gentle-agents.message` completion messages. Nothing reaches the model, and the tool result is left unchanged. See [Learnings from subagent reports](../../../docs/agents.md#learnings-from-subagent-reports).
- **Session capture** — the session is registered on your first prompt, the transcript is flushed after each turn, and a final summary is written when the session ends.
- **Identity declaration** — once your session row exists, every Rembric tool call carries your Pi session id in the `X-Rembric-Session` request header, and the id is also added as `sessionId` to every call that accepts one where the model did not supply it. The server attributes writes to the declared session ahead of any `sessionId` the model passes, so writes attach to your session even with several Pi sessions open in the same project.
- **`<private>` redaction** — anything between `<private>` and `</private>` is replaced with `[REDACTED]` before a transcript leaves your machine. An unclosed `<private>` redacts to the end of the text.

## Tool output

Every Rembric tool result is collapsed to a single line — outcome, the tool's dotted name, how many lines the result has, and the key that expands it:

```
✓ memory.context · 170 lines · ctrl+o to expand
✗ memory.get_batch · 5 lines · ctrl+o to expand
```

Press that key (`app.tools.expand`, `ctrl+o` by default — the line names whatever you have bound) to see the complete result text, unchanged, and press it again to collapse. A failed call is marked separately and Pi paints its row on the error background; expanding it shows the whole diagnostic, error code included.

The toggle is Pi's own and it is **global**: one press expands every tool row in the transcript, Rembric's and the built-ins' alike. Collapsing applies to every tool regardless of size, so what you see does not depend on a threshold you cannot inspect.

## Troubleshooting

| Symptom                                                | Cause                                                                                                          | Fix                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No `memory_*` tools in the session                     | `REMBRIC_SERVER_URL` / `REMBRIC_API_TOKEN` not exported in this shell                                          | A startup notification names the one that is missing; export both and restart Pi                                                  |
| `[rembric] no PROJECT_SLUG in …`                       | Outside a git repository, no `.rembric` in the directory Pi was started in and no `REMBRIC_PROJECT_SLUG`       | Create it with `PROJECT_SLUG=<slug>`; the slug must name a project that exists on the server                                      |
| `Rembric: This repository (…) has no Rembric project`  | The git repository is not bound to a project; every memory tool answers `project_unbound`                      | Ask an admin to bind it from the dashboard, or add a `.rembric`; either applies from the next session                             |
| `Rembric is off — …` inside a git repository           | The server did not answer `POST /api/repositories/resolve`, or the repository is bound to several projects     | Follow the remedy the notification names: update the server, or add a `.rembric`                                                  |
| `[rembric] tool discovery failed: … project_not_found` | The slug names no project on the server — deliberately refused rather than widened                             | Create the project at `…/dashboard/projects`, or fix the slug                                                                     |
| `[rembric] tool discovery failed: … HTTP 401`          | Token is wrong, revoked, or not authorised for that project                                                    | Issue a new one at `…/dashboard/tokens`                                                                                           |
| Tools present but every call fails                     | Server reachable at discovery, not at call time (container restarted, tunnel dropped)                          | `curl -H "Authorization: Bearer $REMBRIC_API_TOKEN" $REMBRIC_SERVER_URL/healthz`                                                  |
| A slash command stays literal                          | The extension is not installed, or prompt templates are disabled (`--no-prompt-templates`)                     | `pi list` should show `@rembric/pi`                                                                                               |
| The last turn is missing from the dashboard summary    | The process exited without reaching the shutdown handler: `SIGKILL`, a crash, or an interrupted print-mode run | Nothing to recover for that session — the per-turn flush bounds the loss to the final turn, and the row is retired as `abandoned` |

## Session close

Pi reports _why_ it is shutting down, and the reason decides whether the session is closed or left open:

| Shutdown reason                                                                  | Session row                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------- |
| `quit` — you exit Pi                                                             | `ended`                                     |
| `new`, `fork`, or a `resume` of a different session (`/new`, `/fork`, `/resume`) | the replaced session is `ended`             |
| `reload`, or a `resume` of the session already open                              | stays `active` — the same session continues |
| any other reason this extension does not recognise                               | stays `active`                              |

Closing the replaced session is what keeps memories attributed. Faced with two `active` sessions for the same token and project, the server refuses to guess which one a memory belongs to — so while both rows are open, every memory saved after a `/new` lands with no session attached. Ending the old row removes the ambiguity.

A `reload` is the same session continuing, and a session that has ended never goes back to `active`. Ending there would cost the attribution of every later save in that Pi process, which is also why an unrecognised reason leaves the row open: not ending is recoverable, ending wrongly is not.

One consequence worth knowing: **resuming a session that already ended re-attaches it.** On the first prompt of the reopened process the extension re-registers the id and POSTs `/api/<slug>/sessions/<id>/resume`, which returns the row to `'active'` and pins the transport to it — so later saves attribute again with no explicit `sessionId`.

An exit that runs no shutdown handler leaves the row `active`; the server retires it as `abandoned` on its own later.

### Exiting: Ctrl-D, or Ctrl-C twice

Pi runs its shutdown handler — where the final summary is written — on a clean exit, on Ctrl-D, on `SIGTERM` and on `SIGHUP`. **Two Ctrl-C presses within 500 ms of each other run the same handler**, in the interactive TUI with the prompt focused and on the default `app.clear` binding (the key Pi's own startup banner advertises for exiting). The session is closed either way, and nothing beyond the current turn is at risk.

A **single** press is not an exit: it clears the prompt and arms the 500 ms window. Measured against Pi 0.84.1 with timed stdin, the two-presses-200 ms-apart arm fired the shutdown handler at 5.8 s, against a no-keys baseline — the stdin EOF alone — of 10.6 s; two presses 1.5 s apart landed on that same EOF at 11.8 s, so the slow pair contributed nothing.

Print mode is the exception, and this one is read from Pi's source rather than measured: `dist/modes/print-mode.js:32-44` registers `["SIGTERM"]` plus `SIGHUP`, and `SIGINT` appears nowhere in that file. `SIGKILL` runs nothing at all, by design.

**Ctrl-D remains the simplest exit** — one keystroke, no timing window, and it does not depend on how you have bound your keys.

## Subagents

A delegated child is not a conversation of its own, so it never registers a session row and its system prompt does not get the server's usage instructions. Rembric tools stay available inside it, and its `memory_save` calls still reach the server. A child is recognised by any of:

| Signal                                     | Set by                                                                |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `ctx.mode` is `rpc`                        | any runtime that spawns `pi --mode rpc` children (gentle-pi, scripts) |
| `GENTLE_PI_AGENTS_CHILD=1`                 | gentle-pi                                                             |
| `PI_SUBAGENT_CHILD=1`                      | pi-subagents, in the runner process that hosts background children    |
| `<active_agent name=` in the system prompt | pi-subagents, on every child agent, including foreground ones         |
| `REMBRIC_SUBAGENT=1`                       | any other spawner that declares its children                          |

`REMBRIC_TRACK_SESSION=1` overrides all of them and tracks the process as a normal session.

## Source

Developed in the Rembric monorepo at [`apps/plugin/.pi-plugin/`](https://github.com/susomejias/rembric/tree/main/apps/plugin/.pi-plugin). Issues and pull requests: [susomejias/rembric](https://github.com/susomejias/rembric).
