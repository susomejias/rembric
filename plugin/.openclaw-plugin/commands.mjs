// Slash command: /rembric status
//
// The handler shape mirrors OpenClaw's real PluginCommandHandler contract:
// `(ctx: PluginCommandContext) => PluginCommandResult` where
// PluginCommandResult is `ReplyPayload & { continueAgent?: boolean }`. The
// only required `ReplyPayload` field for a text-only reply is `text`. Raw
// positional args after the command name arrive via `ctx.args` (a single
// space-separated string, NOT an array) per /tmp/openclaw/src/plugins/
// types.ts::PluginCommandContext.

function maskToken(token) {
  if (!token || typeof token !== 'string') return '<unset>';
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}${'*'.repeat(Math.max(4, token.length - 8))}${token.slice(-4)}`;
}

function parseSubcommand(ctx) {
  const raw = typeof ctx?.args === 'string' ? ctx.args.trim() : '';
  if (!raw) return 'status';
  return raw.split(/\s+/)[0] || 'status';
}

function buildStatusText(api, config) {
  const slotOwner = api.config?.plugins?.slots?.memory ?? '<unset>';
  const slotActive = slotOwner === 'rembric';
  return [
    '# Rembric status',
    `server_url:        ${config.serverUrl}`,
    `api_token:         ${maskToken(config.apiToken)}`,
    `project_slug:      ${config.projectSlug ?? '<from .rembric per cwd>'}`,
    `autoRecall:        ${config.autoRecall}`,
    `autoCapture:       ${config.autoCapture}`,
    `tokenBudget:       ${config.tokenBudget}`,
    `memory slot:       ${slotOwner} ${slotActive ? '(active)' : '(INACTIVE — set plugins.slots.memory to "rembric")'}`,
    `registrationMode:  ${api.registrationMode ?? '<unknown>'}`,
  ].join('\n');
}

export function registerCommands(api, config) {
  if (typeof api.registerCommand !== 'function') {
    api.logger?.debug?.('rembric: api.registerCommand unavailable, skipping /rembric');
    return;
  }
  try {
    api.registerCommand({
      name: 'rembric',
      description: 'Rembric plugin operator commands.',
      acceptsArgs: true,
      handler: async (ctx) => {
        const sub = parseSubcommand(ctx);
        if (sub !== 'status') {
          return { text: `unknown subcommand: ${sub}. Try: /rembric status` };
        }
        return { text: buildStatusText(api, config) };
      },
    });
    api.logger?.info?.('rembric: registered /rembric slash command');
  } catch (err) {
    api.logger?.warn?.(`rembric: api.registerCommand failed: ${String(err)}`);
  }
}

export { parseSubcommand, buildStatusText };
