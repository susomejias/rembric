## Context

The server and the client plugins live on different machines: the Rembric server runs on one host (commonly a VPS), and each plugin is installed on a separate client machine. An MCP tool executes **server-side**, so it can authoritatively report the server's own version but is structurally blind to what plugins (and what plugin versions) exist on any client machine. The two artifacts also version independently — release-please tracks `server` (`0.21.x`) separately from the four plugin components (`plugin-suite`, `0.11.x`).

The repo already has two update mechanisms, and this change reuses both rather than competing with them:

- **Plugins** update through the TUI installer (`apps/plugin/install.sh`, fronted by the repo-root `install.sh` shim) — the single, canonical install/maintenance path (see the `tui-installer` capability and `rembric-tui-installer` skill).
- **Server** updates through Docker on its host, with the richer dashboard-driven flow specified by the `self-update` capability (GitHub release check, capability detection, one-click upgrade).

The `initialize.instructions` block is specified by `mcp-api` (≤800 chars, CI-enforced) and consumed by Claude Code and Codex; Hermes carries a hand-synced parity string in `system_prompt_block` (≤300 chars). opencode does not reliably inject the instructions string but does see the MCP tool manifest.

## Goals / Non-Goals

**Goals:**

- One on-demand, read-only surface — reachable from all four clients — that returns how to update Rembric, acting as the portable equivalent of a Claude-only skill.
- Honesty about topology: never conflate the server version with plugin state; label each command by the machine it runs on; state plainly that the server cannot see client installs.
- Strict delegation: point at the TUI installer (plugins) and the Docker flow (server); reimplement neither detection nor version diffing.
- Discoverability: the instructions block tells agents the tool exists so they call it when asked to update.

**Non-Goals:**

- No client-side detection of installed plugins or their versions (impossible server-side; that is the installer's job).
- No execution of `curl|sh` or `docker` — guidance only.
- No freshness diffing computed inside this tool. It echoes the running server version and points at the installer's read-only `--status --json` for the real installed-vs-available comparison (client-side); it never computes that comparison itself.
- No new dependency, no DB change, no migration.

## Decisions

**Decision: A read-only MCP tool, not a Claude skill, as the primary surface.**
Skills are Claude-Code-only and cannot serve Codex/opencode/Hermes. An MCP tool is the only primitive common to all four clients. Alternatives considered: (a) a Claude-only skill — rejected, fails the "all supported agents" requirement; (b) putting the full guidance into `instructions` — rejected, the 800/300-char caps are nearly full and the guidance would be paid on every session for a rare action; (c) folding into `memory.doctor` — rejected, doctor is "behavior seems off" diagnostics, not the surface an agent reaches for on "how do I update," so discoverability would suffer.

**Decision: Tool name `memory.about`, guidance-only, no parameters.**
`memory.about` keeps the existing `memory.*` namespace and reads as a meta/info tool, which avoids the agent mistaking it for an action that performs the upgrade. Discoverability is driven by a keyword-rich description (`update`/`upgrade`/`plugins`), not the name. Alternative `memory.upgrade_guide` / `rembric.upgrade` considered — more discoverable by name but risks the agent inferring it executes the upgrade; rejected in favor of a safe name + explicit description.

**Decision: Two-axis output, labeled by machine.**
Output is `{ server: { version, where, update }, plugins: { note, status, interactive, update_all, subset }, docs }`. The `server.version` is the live `REMBRIC_VERSION`; everything else is a constant string. The `plugins.note` states explicitly that plugins live per client machine and the server cannot see them. This is the mitigation for the topology trap — the tool never implies it knows local plugin state.

**Decision: For "is there really an update?", point at the installer's read-only `--status --json`, do not compute status server-side.**
The installer already has a read-only `--status [--json]` mode that prints, in one shot, the server state plus each plugin's installed-vs-available version with a per-agent `action` (`none`/`update`/`ahead`/`unknown`). It runs on the client machine — the only place plugin state is knowable — and covers both axes. `memory.about` therefore surfaces that command as `plugins.status` and frames the recommended flow as "status first, update only where `action: update`", instead of trying to compute freshness server-side (impossible for plugins) or wiring the `self-update` service into the tool (would make the pure tool stateful and duplicate dashboard logic). Alternatives considered: (a) tool computes plugin freshness — rejected, server cannot see client installs; (b) tool reuses the `self-update` cached release check for the server axis only — rejected as unnecessary, since `--status --json` already reports server state client-side and keeps the tool a pure constant. This keeps the guidance honest and prevents "update a lo loco".

**Decision: Cite `memory.about` in `instructions`, primary in the 800-char block.**
The `mcp-api` instructions requirement gains a short clause naming `memory.about` as where to learn how to update, kept minimal to stay under 800 chars. This is what the user asked for ("que tenga conocimiento de ella"). opencode, which does not consume instructions, still discovers the tool via the manifest description.

**Decision: Do NOT modify the Hermes `system_prompt_block`; cite the tool only in the canonical `instructions` block.**
Only Claude Code and Codex consume the MCP `instructions` string, so that is where the citation earns its keep. opencode and Hermes do not consume it and instead see `memory.about` in their MCP tool manifest, whose keyword-rich description ("update/upgrade plugins") is enough for the agent to select it on request. The Hermes `system_prompt_block` is at a hard ≤300-char cap already saturated by the session_summary and post-compact triggers; forcing a third trigger for a rare action would mean dropping load-bearing content and copying a large lifecycle requirement block for marginal gain. Alternative — dual-sync the citation into the Hermes prompt block — rejected on cost/benefit. The tool itself is fully available to Hermes regardless; this decision only concerns the prompt-side nudge.

## Risks / Trade-offs

- [Trade-off] A new MCP tool's name+description is advertised in every client's tool manifest on every session (always-on cost ≈ one description line) → Accepted because it is the only cross-client surface and the cost is comparable to the instructions pointer it partly replaces, while reaching opencode (which instructions does not).
- [Risk] The `plugins` commands are static strings that could drift from the canonical installer invocation → Mitigation: derive the install URL/flags from the same canonical values the `tui-installer` spec defines and add a test asserting the tool's command strings match the documented installer entrypoint; never hand-fork the flags.
- [Risk] Agents could read `server.version` as "I am up to date" and skip updating plugins → Mitigation: the output separates axes and the `plugins.note` explicitly says the server cannot see plugin state; the description frames the tool as guidance, not a freshness check.
- [Risk] Adding the citation pushes the instructions block over the 800-char cap → Mitigation: the existing CI length test (`instructions.test.ts`) gates both variants; the clause is written as the shortest possible reference and the test fails the build if exceeded.
- [Trade-off] The tool cannot tell the operator whether a newer plugin version exists → Accepted because that detection is inherently client-side and already lives in the installer; this tool only hands back the command to run.

## Migration Plan

Additive and reversible. Deploy with the next server image: the tool registers at MCP server construction; clients pick it up on their next `initialize`. No data migration, no config change, no operator action. Rollback = revert the registration and the instructions clause; nothing persists.

## Open Questions

- None blocking. The exact wording of the `instructions` citation will be finalized at apply time against the live 800-char budget (the CI length test is the gate).
