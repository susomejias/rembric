# Rembric OpenClaw plugin

This package adds the missing session-lifecycle bridge for OpenClaw:

- creates/upserts the Rembric session row once OpenClaw reaches its first natural finalization
- saves a fallback transcript summary before compaction
- closes the session cleanly on `session_end`

It does **not** register the Rembric MCP server for you. Keep using the normal Rembric MCP URL + Bearer token in your OpenClaw MCP config; this plugin only fills the lifecycle gap so `/dashboard/sessions` stays accurate.

## Local install from the Rembric repo

```bash
openclaw plugins install ./plugin/.openclaw-plugin
```

Then configure the plugin with your Rembric base URL and agent token:

```json5
{
  plugins: {
    entries: {
      'rembric-openclaw': {
        enabled: true,
        config: {
          serverUrl: 'https://memory.example.com',
          apiToken: 'oc-token-XXXXXXXX',
          agentName: 'openclaw',
        },
      },
    },
  },
}
```

Per-project scoping uses the same `.rembric` file as the Claude/Codex plugins:

```bash
echo "PROJECT_SLUG=my-app" > .rembric
```

Without a valid `.rembric`, lifecycle POSTs are skipped and OpenClaw still works as a plain MCP client.
