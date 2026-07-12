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
PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" BIN_SRC="$(pwd)/apps/plugin/bin" \
  sh apps/plugin/.opencode-plugin/install.sh
```

For end-user-style install (curl-pipe-sh, no checkout — verifies the public install path works):

```bash
# Hermes
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh

# opencode
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

For opencode specifically:

```bash
# install.sh copies plugin.ts + rembric-bridge.mjs + rembric-dotenv.mjs to their destinations
# AND prints the MCP block with $HOME expanded. Paste the printed block manually:
cat > ~/.config/opencode/opencode.json <<JSON
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "$HOME/.config/rembric/bin/rembric-bridge.mjs"],
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

### Dashboard / DB verification

```bash
sqlite3 data-dev/data.db "SELECT id, agent, status, substr(title,1,40) FROM sessions ORDER BY started_at DESC LIMIT 5;"
```

For sub-agent filter changes: send a `session.created` with `parentID` set OR `title` ending in ` subagent)`. Verify the resulting query shows ONLY top-level sessions (sub-agent IDs absent).

## 6. Tear down cleanly

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
bash apps/plugin/.<client>-plugin/uninstall.sh   # works from a local checkout for any client
```

**Restore the user's agent config file** to its prior state. If they didn't have an `opencode.json` before, delete it. If they did, restore from the backup you (should have) made.

For opencode specifically, leave `opencode.json` with `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` placeholders if you wrote anything there:

```bash
cat > ~/.config/opencode/opencode.json <<JSON
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "$HOME/.config/rembric/bin/rembric-bridge.mjs"],
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
