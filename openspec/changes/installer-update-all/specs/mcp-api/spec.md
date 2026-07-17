## MODIFIED Requirements

### Requirement: The MCP server MUST expose a read-only `memory.about` update-guidance tool

The server SHALL register a `memory.about` tool that returns Rembric update guidance as structured data. The tool SHALL take no input parameters, SHALL be read-only (no database access, no persistence, no mutation of any kind), and SHALL be idempotent. Its registered description SHALL contain the keywords `update` and `upgrade` and reference plugins so an agent selects it when the operator asks how to update or upgrade Rembric.

The tool acts as the cross-client equivalent of a Claude-Code skill: it is the portable surface — reachable from all four supported clients — that hands the operator the commands to run. It SHALL be **guidance-only**: it returns command strings for the operator to run and SHALL NOT execute `curl`, `sh`, `docker`, or any shell command itself.

The response SHALL be split into two axes that are never conflated:

- `server`: an object containing the running server version (the value of `REMBRIC_VERSION`), a human-readable note that this is the server (which runs wherever the tool executes, e.g. the operator's VPS), and the server update path on that host (`docker compose pull && docker compose up -d`). This axis SHALL NOT claim anything about client plugin state.
- `plugins`: an object containing the canonical TUI-installer commands — a **read-only status command** (`… --status --json`) that reports the server and each plugin's installed-vs-available version with a per-agent `action` (`none`/`update`/`ahead`/`unknown`), the interactive entrypoint (`curl -fsSL <install-url> | sh`), the update-all variant (`… --action=update`), and a subset example (`… --action=update --agent=<a,b>`) — together with an explicit note that plugins are installed per client machine, that this server cannot see them, that the operator runs the command on each machine where Rembric is used, and that the `update_all` command is safe to run directly (it updates only agents with an update available and skips the rest without erroring) — the status-first-then-selective-update advice applies to the `subset` command, where the operator names specific agents.

The status command SHALL be the installer's existing read-only `--status --json` mode; the tool SHALL NOT compute installed-vs-available state itself (that detection is client-side and owned by the installer). The status command SHALL NOT include `--action=update` or any mutating flag.

The `plugins` command strings SHALL be derived from the canonical installer entrypoint and flags defined by the `tui-installer` capability; the tool SHALL NOT fork or hand-edit the installer's flag set. The `server` update command SHALL NOT duplicate the dashboard-driven one-click flow owned by the `self-update` capability; `memory.about` only surfaces the manual host command and the running version.

#### Scenario: A client calls memory.about

- **WHEN** an authenticated MCP client calls `memory.about` with no arguments
- **THEN** the tool SHALL return a result containing a `server` object whose version equals the running `REMBRIC_VERSION` and a `plugins` object containing the installer command(s)
- **AND** the result SHALL NOT trigger any database read or write

#### Scenario: The two axes are labeled and never conflated

- **WHEN** the tool result is inspected
- **THEN** the `plugins` axis SHALL include a note stating that plugins live on each client machine and that the server cannot see them
- **AND** the `server` version SHALL NOT be presented as an indicator of whether any client plugin is up to date

#### Scenario: The tool is guidance-only and never executes

- **WHEN** `memory.about` is invoked
- **THEN** the server SHALL NOT spawn a process, run `curl`/`sh`/`docker`, or perform any side effect; it SHALL only return command strings for the operator to run

#### Scenario: The plugins commands match the canonical installer entrypoint

- **WHEN** the tool's `plugins` command strings are compared against the canonical installer entrypoint defined by the `tui-installer` capability
- **THEN** the interactive and `--action=update` invocations SHALL reference that same entrypoint and flag set (no forked URL or flags)

#### Scenario: The tool offers a read-only status command, and directs status-first checking to the subset path

- **WHEN** the `plugins` axis is inspected
- **THEN** it SHALL include a `status` command using the installer's `--status --json` mode that references the canonical entrypoint
- **AND** that command SHALL NOT contain `--action=update` or any other mutating flag
- **AND** the `plugins.note` SHALL state that `update_all` is safe to run directly without checking `status` first
- **AND** the `plugins.note` SHALL direct the operator to check `status` first specifically when using the `subset` command to update named agents
