## Why

Rembric has five disjoint install paths today (server via Docker; Claude Code + Codex via marketplace; Hermes + opencode via per-client `install.sh`), each documented in a different place, with no single entry point and no way to see what is already installed or whether it is current. A newcomer must read the README, `docs/agents.md`, and four client READMEs to get set up. We want one brand-styled, copy-pasteable entry point that detects what is present, shows installed-vs-available versions, and routes install / update / uninstall to the primitive each client already uses — without resurrecting the deliberately-sunset npm CLI (this is a shell orchestrator over Docker + curl, nothing is published to npm).

## What Changes

- **New top-level orchestrator** `apps/plugin/install.sh`: a single POSIX `sh` script, served via `curl … | sh`, presenting a brand-styled (lime `#c6f24e` on `#0a0a0a`) interactive menu. It is an orchestrator — it calls the per-client primitives and CLIs that already exist; it does not embed their logic.
- **TTY-aware interactivity**: prompts read from `/dev/tty` so the menu works under `curl … | sh`; with no controlling TTY the script falls back to a non-interactive mode driven by flags / env (`--server`, `--client=…`, `--action=install|update|uninstall`, `REMBRIC_NONINTERACTIVE=1`). Colour respects `NO_COLOR` and `[ -t 1 ]`, with truecolor→256→plain degradation.
- **Server section** (prepare-only): downloads `docker-compose.yml` + `.env.example`, prompts for `REMBRIC_ADMIN_TOKEN`, and leaves the directory ready — the operator runs `docker compose up -d` themselves. Update re-fetches `docker-compose.yml` and reminds the operator to `docker compose pull` / bump `REMBRIC_VERSION`. The script never invokes Docker.
- **Plugins section** (stateful): detects which of the four clients are present, reads each client's **installed** plugin version from its on-disk manifest, compares against the **available** version from a single fetch of `.release-please-manifest.json` at the same git ref it would install from, and renders a status table. Per client it offers Install / Update / Uninstall, mapped to that client's real primitive:
  - opencode, Hermes → orchestrate their `install.sh` / `uninstall.sh`.
  - Claude Code, Codex → print (and, when the client binary is detected, optionally run) the client's marketplace CLI commands. **No** repo-side install script is created for these — they are marketplace-based by design.
- **New primitive** `apps/plugin/.hermes-plugin/uninstall.sh`: idempotent, mirrors `apps/plugin/.opencode-plugin/uninstall.sh`. Removes only the plugin's installed files and `disable`s it; never touches user config, credentials, or `.rembric` files; reports what it left behind.
- **Conservative-uninstall rule** applied across all clients the orchestrator can uninstall: delete only plugin-owned files; never remove operator config (`opencode.json`, `~/.hermes/.env`), credentials, or `.rembric` markers; print what was deliberately left.
- **Docs**: README Quickstart and `docs/agents.md` gain the one-line installer entry point alongside (not replacing) the existing per-client and Docker instructions.

No load-bearing server invariant (append-only memory, scope-at-service, `topic_key`, judgment freshness) is touched — this change lives entirely in distribution/tooling.

## Capabilities

### New Capabilities

- `tui-installer`: the `apps/plugin/install.sh` orchestrator — its menu structure, TTY/non-interactive behaviour, brand-colour rendering with degradation, server prepare-only flow, per-client presence + version detection, installed-vs-available comparison against the install ref, and the install/update/uninstall routing per client. Owned by the `plugin-shared` release-please component.

### Modified Capabilities

- `hermes-agent-plugin`: the plugin directory gains a fifth top-level file `uninstall.sh` (the "exactly four files" requirement and its scenario become five), and a new Uninstall-script-contract requirement mirroring opencode's conservative, idempotent uninstall semantics.

## Impact

- **New files**: `apps/plugin/install.sh`, `apps/plugin/.hermes-plugin/uninstall.sh`.
- **Modified files**: `README.md` (Quickstart), `docs/agents.md` (per-client sections), `apps/plugin/README.md` (installer entry point), `apps/plugin/.hermes-plugin/README.md` (uninstall step).
- **Reads at runtime (no modification)**: `.release-please-manifest.json`, each client's installed manifest (`~/.claude/…/plugin.json`, `~/.hermes/plugins/rembric/plugin.yaml`, `~/.config/opencode/plugins/rembric.ts` version comment), and the existing `apps/plugin/.opencode-plugin/{install,uninstall}.sh` + `apps/plugin/.hermes-plugin/install.sh`.
- **Versioning**: `apps/plugin/install.sh` falls under the `plugin-shared` release-please component, so touching it cascades a version bump to the `plugin-suite` linked group (claude-code-plugin, codex-plugin, opencode-plugin). `apps/plugin/.hermes-plugin/uninstall.sh` bumps the self-contained `hermes-plugin` component.
- **Supply-chain posture**: a `curl | sh` installer is a supply-chain surface; docs MUST offer the download-inspect-run alternative and a tag-pinned URL. No new npm dependency, no lifecycle script, no change to `.npmrc` / `pnpm-workspace.yaml` / lockfile.
- **Open question deferred to implementation**: the exact on-disk path of the Claude Code marketplace-installed `plugin.json` (under `~/.claude/`) for version detection; confirmation that opencode's `install.sh` `sed` preserves the `@rembric-plugin-version` comment in the installed file.
