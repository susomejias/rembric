# E2E walkthrough — exercising plugin changes against `pnpm run dev:docker:up`

## 1. Bring up the dev stack

```bash
pnpm run dev:docker:up
```

Foreground process. Logs to stdout AND `./data-dev/data.db` (host bind-mount). Every `up` wipes and reseeds, so you get a predictable baseline:

- Project: `demo` (slug)
- Tokens (regenerated every reset; capture from the boot banner):
  - `demo-reader: <plaintext>`
  - `demo-writer: <plaintext>`
- Listening on `http://127.0.0.1:8788` (host-mapped from the container's `:8787`).
- Admin token from the `.env` file in the repo (`REMBRIC_ADMIN_TOKEN`).

Don't grep `/tmp/rembric-dev*.log` for "listening" — the docker-compose attach mode buffers stdout; use `docker logs rembric-dev | tail -30` instead.

## 2. Get the seeded token

```bash
docker logs rembric-dev 2>&1 | grep -aE 'demo-writer|demo-reader' | head -2
```

`demo-writer` has write permission to the `demo` project — what you want for any handler that POSTs.

## 3. Install the plugin under test

For dev iteration against a local checkout (preferred — exercises the same code your branch is on):

```bash
# Hermes
PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh

# opencode
PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" \
BIN_SRC="$(pwd)/apps/plugin/bin" \
MCP_BRIDGE_SRC="$(pwd)/apps/plugin/mcp-bridge" \
  sh apps/plugin/.opencode-plugin/install.sh
```

For end-user-style install (curl-pipe-sh, no checkout — verifies the public install path works):

```bash
# Hermes
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh

# opencode
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

Pi has no repo-side install script — its mechanism is its own CLI (`pi install npm:@rembric/pi` for the registry form, **never** with a version suffix; the local-path form for iterating on a branch is in `apps/plugin/.pi-plugin/README.md`). Note the local-path shape runs **no** dependency install, which is why the extension declares zero runtime dependencies. Credentials are shell-only — this harness injects nothing from its settings file:

```bash
export REMBRIC_SERVER_URL=http://127.0.0.1:8788
export REMBRIC_API_TOKEN=<demo-writer-plaintext-from-step-2>
export BRIDGE_VERSION="$(node -p 'require("./apps/plugin/package.json").version')"
```

For opencode specifically:

```bash
# install.sh copies plugin.ts + shared modules to their destinations and
# prints the pinned MCP block. Paste it manually only if opencode.json is absent:
cat > ~/.config/opencode/opencode.json <<JSON
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["npx", "-y", "@rembric/mcp-bridge@${BRIDGE_VERSION}"],
      "environment": {
        "REMBRIC_SERVER_URL": "http://127.0.0.1:8788",
        "REMBRIC_API_TOKEN": "<demo-writer-plaintext-from-step-2>"
      },
      "enabled": true
    }
  }
}
JSON
```

## 4. Make a `.rembric` for path-scoping

```bash
mkdir -p /tmp/rembric-spike-real
echo 'PROJECT_SLUG=demo' > /tmp/rembric-spike-real/.rembric
cd /tmp/rembric-spike-real
```

The bridge will resolve `.rembric` via its `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain.

## 5. Exercise the lifecycle path that your change affects

### MCP transport / bridge changes

```bash
opencode mcp list --print-logs --log-level DEBUG 2>&1 | grep -aE 'rembric-bridge|connected|toolCount|✓|✗'
```

Expected:

- `[rembric-bridge] projectDir=/tmp/rembric-spike-real (from PWD) url=http://127.0.0.1:8788/mcp/demo`
- `[Local→Remote] initialize` then `[Remote→Local] 0`
- `toolCount=19 create() successfully created client`
- `✓ rembric connected`

### Handler-level changes (without LLM cost)

Direct invocation via tsx. Pattern from `add-opencode-plugin`:

```ts
// /tmp/exercise.ts
import { RembricPlugin } from '/Users/<user>/.config/opencode/plugins/rembric.ts';
process.env.REMBRIC_SERVER_URL = 'http://127.0.0.1:8788';
process.env.REMBRIC_API_TOKEN = '<demo-writer>';

async function main() {
  const handlers = await RembricPlugin({ directory: '/tmp/rembric-spike-real' });
  const sessionId = 'test-' + Date.now();

  await handlers.event!({
    event: {
      type: 'session.created',
      properties: { info: { id: sessionId, parentID: '', title: 'e2e test' } },
    },
  });

  // Add other handlers to exercise…
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

```bash
pnpm exec tsx /tmp/exercise.ts
```

### Pi: tool discovery and session round-trip

The extension holds the MCP client, so "did it connect" and "did it discover" are one question. Confirm the discovered count matches the server's `registerTool` call sites in `apps/server/src/mcp/server.ts` (derive it — do not hard-code), that the registered names carry underscores (`memory_save`), and that a proxied save is readable back by an independent `memory.get` with a fabricated id returning `not_found` as the control. Then end the session **with Ctrl-D** — one keystroke, no timing window, and it works in both modes, whereas Ctrl-C only exits the TUI when pressed twice within 500 ms — and check for a non-null summary.

### Dashboard / DB verification

```bash
sqlite3 data-dev/data.db "SELECT id, agent, status, substr(title,1,40) FROM sessions ORDER BY started_at DESC LIMIT 5;"
```

For sub-agent filter changes: send a `session.created` with `parentID` set OR `title` ending in `subagent)`. Verify the resulting query shows ONLY top-level sessions (sub-agent IDs absent).

## 5b. Driving a real CLI safely

Direct `tsx` invocation proves the handler; it cannot prove the harness delivers what the handler expects. When that is the question — does the event actually fire, does its payload carry the field — you have to run the real binary, and the operator's machine is not a test fixture. Six rails, each of which prevented a concrete accident when the Pi session-end change was validated.

**1. Never inherit the operator's environment.** Their shell exports `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` for a live deployment, so a naive run files probe sessions into production data. Export both explicitly on the command line for every run, and verify the URL is the local one before starting.

**2. Redirect `HOME` to a scratch directory.** The CLI then starts with no installed extensions, no auth and no settings, so nothing you do can mutate the operator's real config — and no unrelated extension loads alongside yours and double-registers.

```bash
S=/tmp/scratch/e2e; mkdir -p "$S/pihome"
HOME="$S/pihome" REMBRIC_SERVER_URL=http://127.0.0.1:8788 REMBRIC_API_TOKEN="$TOK" pi …
```

**3. Load the plugin per run, do not install it.** Pi takes `-e <path>` ("Load an extension file"). Installing mutates settings you then have to restore, and a half-restored setup is worse than no test.

**4. Mirror the repo layout instead of running `materialize`.** `scripts/pi-package.mjs materialize` rewrites `.pi-plugin/index.ts`'s import specifiers **in place** and drops `bin/` and `commands/` beside it — publish-time transforms that must never be committed, and easy to leave behind. Copy the files into a scratch tree that reproduces the repo's shape instead, and the relative imports resolve unchanged:

```
$S/plugin/.pi-plugin/index.ts     # copied verbatim; '../bin/…' still resolves
$S/plugin/bin/rembric-*.mjs
```

**5. Kill the model cost with an invalid key, not with a mock.** Pass `--model <provider>/<id> --api-key deliberately-invalid` (the key is rejected without `--model`). The provider returns 400 and nothing is billed — and the lifecycle you care about still runs, because `before_agent_start` fires **after the user submits and before the LLM loop**, so session registration and transcript accumulation both happen before the failure.

**6. Assert against the database, never the CLI's stdout.** TUI output is ANSI-heavy and greps against it produce false negatives.

```bash
sqlite3 data-dev/data.db "SELECT id,status,ended_at,substr(coalesce(summary,''),1,30) FROM sessions WHERE agent='pi' ORDER BY started_at;"
```

### Two method rules, both learned by being bitten

**Run the paired control from `git HEAD`.** Copy the pre-change client and core out of git into a second scratch tree and run the identical flow. The treatment proves nothing until the control fails in the expected direction; both arms must also show they did _something_ (a written transcript), or a handler that no-ops passes the control for the wrong reason.

**Clear leftover `active` rows between runs.** Session state is shared across runs, and the resolver returns "sole match or nothing" — so one un-ended session from an earlier arm silently poisons attribution in every later one. An attribution probe failed exactly this way, and the failure was mistaken for a defect until the bench was cleaned:

```bash
for id in $(sqlite3 data-dev/data.db "SELECT id FROM sessions WHERE agent='pi' AND status='active';"); do
  curl -sf -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
    -d '{}' "http://127.0.0.1:8788/api/<slug>/sessions/$id/end"
done
```

### Driving a real Claude Code (hook-contract changes)

The install wizard's `${user_config.*}` flow can't be scripted, but the hook CONTRACT (host → script stdin → script stdout → host interpretation) can be exercised without it: register the repo's hook scripts directly in a scratch `settings.json`. Rails, each learned the hard way:

**1. Isolate with `CLAUDE_CONFIG_DIR`, not `HOME`.** A nested `claude` under the operator's real config loads their installed rembric plugin, whose hooks fire against their real server — probe sessions land in production data. A scratch `CLAUDE_CONFIG_DIR` starts with no plugins, no settings, no auth.

**2. Credentials: copy the file, NEVER read it.** The scratch dir needs the operator's OAuth to run at all. Copy `.credentials.json` byte-for-byte (`install -m 600 src dst`) into the scratch config dir — never `cat`/parse it, never extract the token into an env var, an argument, or a log, and never echo the copy's contents to verify it. If a permission layer blocks the copy, ask the operator to run the copy themselves; do not work around it by reading the file. Purge every copy in teardown (`rm` the scratch `.credentials.json` alongside the seeded-token files). Presence checks (`test -f`) are the only inspection allowed.

**3. Generate `settings.json` with single-quoted env values, and validate with `jq -e` before launching.** Hook commands embed `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` inline (double quotes break the JSON). An invalid `settings.json` is ignored SILENTLY — the session runs, hooks never fire, and nothing tells you why.

**4. Pre-seed the turn counter to reach cadence in one turn.** The counter is one byte per turn at `${TMPDIR:-/tmp}/rembric-turnnudge/<session-id>`; pick the session id yourself with `--session-id $(uuidgen)`, write N-1 bytes, and the first prompt lands on turn N. Saves N-1 model calls per arm.

**5. Bound cost and blast radius.** `--model claude-haiku-4-5-20251001`, `--allowedTools` scoped to the one tool the probe needs (plus `mcp__rembric` if the run must exercise MCP), `--mcp-config <scratch>.json --strict-mcp-config`, and an external `timeout` on every run — a hook-loop bug means the turn may never end on its own (measured: an unguarded Stop reminder re-entered 141 times in 10 minutes; the host cap resets on tool-call responses and never engaged).

**6. Instrument the hook, not the TUI.** Wrap the script under test in a logger that records each invocation's key stdin fields and emitted byte count, then assert on that log plus the DB. Run the control arm from `git HEAD` copies of the scripts (git archive), the treatment arm from the working tree, and demand the control fails in the expected direction.

### Driving an interactive TUI

Feed timed keystrokes through a pty. Slash commands and quit paths only exist in interactive mode, so print mode cannot reach them:

```sh
# drive.sh — \r, not \n; the delays must clear each turn
sleep 6;  printf 'first prompt\r'
sleep 10; printf '/new\r'
sleep 8;  printf 'second prompt\r'
sleep 30; printf '/quit\r'
sleep 5
```

```bash
script -q -c "pi -e $S/plugin/.pi-plugin/index.ts --model google/gemini-2.0-flash --api-key invalid" /dev/null < <(./drive.sh) > tui.log 2>&1
```

To probe the server mid-session (attribution, ambiguity), fire a background job on a delay that lands inside one of those sleeps, rather than trying to synchronise with the TUI.

## 6. Tear down cleanly

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
bash apps/plugin/.<client>-plugin/uninstall.sh   # opencode + Hermes; Pi has no repo-side script — use its own removal verb
```

**Restore the user's agent config file** to its prior state. If they didn't have an `opencode.json` before, delete it. If they did, restore from the backup you (should have) made.

For opencode specifically, restore `opencode.json` to its prior bytes. If it was absent, leave it absent; the installer only prints this snippet:

```bash
cat > ~/.config/opencode/opencode.json <<JSON
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["npx", "-y", "@rembric/mcp-bridge@${BRIDGE_VERSION}"],
      "environment": {
        "REMBRIC_SERVER_URL": "<REMBRIC_SERVER_URL>",
        "REMBRIC_API_TOKEN": "<REMBRIC_API_TOKEN>"
      },
      "enabled": true
    }
  }
}
JSON
```

## When local e2e is not possible

Cases:

- Client requires a TUI with a live LLM call you'd burn user's tokens for.
- Codex CLI hooks are stable and on by default (`codex-cli 0.142.3+`), but trust requires interactive `/hooks` approval.
- Claude Code's `${user_config.*}` substitution requires the install wizard → keychain flow which can't be scripted.
- The tool isn't installed on the dev machine.

Always tell the user explicitly:

> "I can't drive `<specific path>` from this environment. Unit tests cover `<list>`. Manual verification needed for `<list>`. Want the steps?"

Then list the manual smoke procedure. Don't say "verified e2e" when you only ran unit tests.
