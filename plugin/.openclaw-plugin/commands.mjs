// Slash command: /rembric status

function maskToken(token) {
  if (!token || typeof token !== 'string') return '<unset>';
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}${'*'.repeat(Math.max(4, token.length - 8))}${token.slice(-4)}`;
}

export function registerCommands(api, config) {
  if (typeof api.registerCommand !== 'function') {
    api.logger?.debug?.('rembric: api.registerCommand unavailable, skipping /rembric');
    return;
  }
  api.registerCommand({
    name: 'rembric',
    description: 'Rembric plugin operator commands.',
    handler: async (args) => {
      const sub = args?.[0] || 'status';
      if (sub !== 'status') {
        return {
          ok: false,
          message: `unknown subcommand: ${sub}. Try: /rembric status`,
        };
      }
      const slotOwner = api.config?.plugins?.slots?.memory ?? '<unset>';
      const slotActive = slotOwner === 'rembric';
      const lines = [
        '# Rembric status',
        `server_url:   ${config.serverUrl}`,
        `api_token:    ${maskToken(config.apiToken)}`,
        `project_slug: ${config.projectSlug ?? '<from .rembric per cwd>'}`,
        `autoRecall:   ${config.autoRecall}`,
        `autoCapture:  ${config.autoCapture}`,
        `tokenBudget:  ${config.tokenBudget}`,
        `memory slot:  ${slotOwner} ${slotActive ? '(active)' : '(INACTIVE — set plugins.slots.memory to "rembric")'}`,
      ];
      return { ok: true, message: lines.join('\n') };
    },
  });
}
