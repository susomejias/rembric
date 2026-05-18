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
// Mirror plugin/bin/rembric-bridge.mjs::SLUG_RE — same .rembric files
// work across every client, and the same regex gates `project_slug`
// config so a typo doesn't silently break path-scoping.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function readConfig(pluginConfig, logger) {
  const serverUrl = String(pluginConfig?.server_url ?? '').trim();
  const apiToken = String(pluginConfig?.api_token ?? '').trim();
  const autoRecall = pluginConfig?.autoRecall !== false; // default true
  const autoCapture = pluginConfig?.autoCapture === true; // default false
  const tokenBudget =
    typeof pluginConfig?.tokenBudget === 'number' && pluginConfig.tokenBudget > 0
      ? pluginConfig.tokenBudget
      : DEFAULT_TOKEN_BUDGET;
  let projectSlug = null;
  const rawSlug =
    typeof pluginConfig?.project_slug === 'string' ? pluginConfig.project_slug.trim() : '';
  if (rawSlug) {
    if (SLUG_RE.test(rawSlug)) {
      projectSlug = rawSlug;
    } else {
      logger?.warn?.(
        `rembric: project_slug "${rawSlug}" does not match ${SLUG_RE.source} — ignoring and falling back to per-cwd .rembric resolution.`,
      );
    }
  }
  return { serverUrl, apiToken, autoRecall, autoCapture, tokenBudget, projectSlug };
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
      project_slug: { type: 'string' },
    },
  },
  register(api) {
    // Diagnostic: dump what the api surface actually exposes for this
    // third-party plugin. OpenClaw may inject a stricter shape than the
    // one its bundled plugins see; this surfaces which register* methods
    // are usable at runtime so we can match the real API instead of the
    // SDK-types documentation.
    try {
      const apiKeys = Object.keys(api ?? {})
        .filter((k) => typeof api[k] === 'function')
        .sort();
      api.logger?.info?.(`rembric: api method keys = [${apiKeys.join(', ')}]`);
      const nestedKeys = [
        'config',
        'pluginConfig',
        'runtime',
        'logger',
        'session',
        'agent',
        'lifecycle',
      ]
        .filter((k) => api[k] && typeof api[k] === 'object')
        .map((k) => `${k}: {${Object.keys(api[k]).slice(0, 10).join(', ')}…}`);
      if (nestedKeys.length) {
        api.logger?.info?.(`rembric: api nested = ${nestedKeys.join(' | ')}`);
      }
    } catch (err) {
      api.logger?.warn?.(`rembric: api-shape diagnostic failed: ${String(err)}`);
    }

    const config = readConfig(api.pluginConfig, api.logger);

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
    // (memory.*, project.*). When config.projectSlug is set, the URL is
    // path-scoped to `/mcp/<slug>` from the first connect; otherwise it
    // is path-less and project scope falls back to per-call `project.use`
    // or to SessionRouter resolution via the active session row.
    const mcpClient = createMcpClient({
      serverUrl: config.serverUrl,
      apiToken: config.apiToken,
      slug: config.projectSlug,
      logger: api.logger,
    });

    // The HTTP client speaks Rembric's `/api/<slug>/sessions(*)` for
    // session lifecycle. Lifecycle hooks prefer config.projectSlug when
    // set; otherwise resolve per-call from `.rembric::PROJECT_SLUG` in
    // the event's cwd.
    const httpClient = createHttpClient({
      serverUrl: config.serverUrl,
      apiToken: config.apiToken,
      logger: api.logger,
    });

    // Each stage is wrapped independently — one bad SDK-shape mismatch
    // shouldn't tear down the whole plugin's registration. Specific
    // failures are logged so the user can run `openclaw plugins logs
    // rembric` and see which surface broke.
    function safeStage(name, fn) {
      try {
        fn();
      } catch (err) {
        api.logger?.warn?.(`rembric: stage "${name}" failed: ${String(err)}`);
      }
    }
    safeStage('registerTools', () => registerTools(api, mcpClient));
    safeStage('registerHooks', () =>
      registerHooks(api, httpClient, { projectSlug: config.projectSlug }),
    );
    safeStage('registerMemorySurface', () => registerMemorySurface(api, mcpClient, config));
    safeStage('registerCommands', () =>
      registerCommands(api, {
        serverUrl: config.serverUrl,
        apiToken: config.apiToken,
        autoRecall: config.autoRecall,
        autoCapture: config.autoCapture,
        tokenBudget: config.tokenBudget,
        projectSlug: config.projectSlug,
      }),
    );

    api.logger?.info?.(
      `rembric: registered (server=${config.serverUrl}, projectSlug=${config.projectSlug ?? '<from .rembric>'}, autoRecall=${config.autoRecall}, autoCapture=${config.autoCapture})`,
    );
  },
};

export default plugin;
export { readProjectSlug };
