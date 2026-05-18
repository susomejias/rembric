// Rembric native OpenClaw plugin (kind: memory).
//
// Entry point: OpenClaw invokes the default export's `register(api)`
// during plugin activation. The plugin reads its config from
// `api.pluginConfig`, wires:
//   - tool registrations (17 memory_* / project_* tools → MCP wire)
//   - session lifecycle hooks (session_start/end, before/after_compaction → HTTP /api)
//   - memory capability (claims OpenClaw memory slot)
//   - memory prompt section (auto-recall, gated on config.autoRecall)
//   - interactive handler (remember|recall|... matcher)
//   - /rembric slash command
//
// No dependencies. The OpenClaw plugin SDK is workspace:* upstream and
// not installable here; runtime API is injected by the host.

import { createMcpClient } from './mcp-client.mjs';
import { createHttpClient, readProjectSlug } from './http-client.mjs';
import { registerTools } from './tools.mjs';
import { registerHooks } from './hooks.mjs';
import { registerMemorySurface } from './memory-capability.mjs';
import { registerCommands } from './commands.mjs';

const PLUGIN_ID = 'rembric';
const DEFAULT_TOKEN_BUDGET = 1800;

function readConfig(pluginConfig) {
  const serverUrl = String(pluginConfig?.server_url ?? '').trim();
  const apiToken = String(pluginConfig?.api_token ?? '').trim();
  const autoRecall = pluginConfig?.autoRecall !== false; // default true
  const autoCapture = pluginConfig?.autoCapture === true; // default false
  const tokenBudget =
    typeof pluginConfig?.tokenBudget === 'number' && pluginConfig.tokenBudget > 0
      ? pluginConfig.tokenBudget
      : DEFAULT_TOKEN_BUDGET;
  return { serverUrl, apiToken, autoRecall, autoCapture, tokenBudget };
}

function warnIfSlotMismatch(api) {
  const owner = api.config?.plugins?.slots?.memory;
  if (owner && owner !== PLUGIN_ID) {
    api.logger?.warn?.(
      `rembric: another plugin owns the memory slot (plugins.slots.memory="${owner}"). ` +
        `Rembric's auto-recall integration is INACTIVE until you set plugins.slots.memory to "rembric".`,
    );
  } else if (!owner) {
    api.logger?.warn?.(
      'rembric: plugins.slots.memory is not set. Add `"plugins": { "slots": { "memory": "rembric" } }` ' +
        'to ~/.openclaw/openclaw.json to activate the memory slot.',
    );
  }
}

const plugin = {
  id: PLUGIN_ID,
  name: 'Rembric',
  description:
    'Self-hosted memory, sessions, and dashboard for AI coding agents. Native OpenClaw memory provider.',
  // NOTE: server_url and api_token are NOT declared `required` in the
  // JSON schema. OpenClaw validates configSchema at startup against the
  // user's `plugins.entries.rembric.config` block; a strict `required`
  // there refuses to boot the CLI before the user has filled the values.
  // Instead we check at register-time below and log + return gracefully
  // (agentmemory pattern). See openclaw.plugin.json::configSchema for
  // the on-disk schema that mirrors this — both must omit `required`.
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      server_url: { type: 'string' },
      api_token: { type: 'string' },
      autoRecall: { type: 'boolean', default: true },
      autoCapture: { type: 'boolean', default: false },
      tokenBudget: { type: 'number', default: DEFAULT_TOKEN_BUDGET },
    },
  },
  register(api) {
    const config = readConfig(api.pluginConfig);

    if (!config.serverUrl || !config.apiToken) {
      api.logger?.error?.(
        'rembric: server_url and api_token are required. ' +
          'Configure them in ~/.openclaw/openclaw.json under plugins.entries.rembric.config.',
      );
      return;
    }

    warnIfSlotMismatch(api);

    if (config.autoCapture) {
      api.logger?.warn?.(
        'rembric: autoCapture is enabled. This is experimental — Rembric prefers explicit ' +
          'memory_save calls with a topic_key. Errors during auto-capture are silently logged.',
      );
    }

    // The MCP client speaks Rembric's `/mcp` JSON-RPC for tool calls
    // (memory.*, project.*). It is path-less; project scope is resolved
    // either by api.pluginConfig or by per-call `project.use` invocation.
    const mcpClient = createMcpClient({
      serverUrl: config.serverUrl,
      apiToken: config.apiToken,
      slug: null,
      logger: api.logger,
    });

    // The HTTP client speaks Rembric's `/api/<slug>/sessions(*)` for
    // session lifecycle. Lifecycle hooks resolve slug per-call from
    // `.rembric::PROJECT_SLUG` in the event's cwd.
    const httpClient = createHttpClient({
      serverUrl: config.serverUrl,
      apiToken: config.apiToken,
      logger: api.logger,
    });

    registerTools(api, mcpClient);
    registerHooks(api, httpClient);
    registerMemorySurface(api, mcpClient, config);
    registerCommands(api, {
      serverUrl: config.serverUrl,
      apiToken: config.apiToken,
      autoRecall: config.autoRecall,
      autoCapture: config.autoCapture,
      tokenBudget: config.tokenBudget,
    });

    api.logger?.info?.(
      `rembric: registered (server=${config.serverUrl}, autoRecall=${config.autoRecall}, autoCapture=${config.autoCapture})`,
    );
  },
};

export default plugin;
export { readProjectSlug };
