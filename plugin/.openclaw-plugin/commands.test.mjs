import { describe, it, expect } from 'vitest';
import { registerCommands, parseSubcommand } from './commands.mjs';

function buildApi(slotOwner = 'rembric', registrationMode = 'full') {
  let cmd;
  return {
    config: { plugins: { slots: { memory: slotOwner } } },
    registrationMode,
    registerCommand: (def) => {
      cmd = def;
    },
    logger: { warn: () => {}, debug: () => {}, info: () => {} },
    get cmd() {
      return cmd;
    },
  };
}

function ctxWithArgs(args) {
  return { channel: 'tui', isAuthorizedSender: true, commandBody: `/rembric ${args}`, args };
}

const CONFIG = {
  serverUrl: 'https://memory.example.com',
  apiToken: 'rbr_12345678abcd',
  autoRecall: true,
  autoCapture: false,
  tokenBudget: 1800,
  projectSlug: null,
};

describe('parseSubcommand', () => {
  it('defaults to status when ctx.args is missing or empty', () => {
    expect(parseSubcommand({})).toBe('status');
    expect(parseSubcommand({ args: '' })).toBe('status');
    expect(parseSubcommand({ args: '   ' })).toBe('status');
  });
  it('reads the first whitespace-delimited token from ctx.args', () => {
    expect(parseSubcommand({ args: 'status' })).toBe('status');
    expect(parseSubcommand({ args: 'unknown extra args' })).toBe('unknown');
  });
});

describe('registerCommands', () => {
  it('registers /rembric with status as default subcommand', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    expect(api.cmd?.name).toBe('rembric');
    const result = await api.cmd.handler(ctxWithArgs(''));
    expect(result.text).toMatch(/Rembric status/);
    expect(result.text).toMatch(/server_url:\s+https:\/\/memory\.example\.com/);
    expect(result.text).toMatch(/memory slot:\s+rembric \(active\)/);
  });

  it('masks the api token body', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(ctxWithArgs('status'));
    expect(result.text).not.toContain('rbr_12345678abcd');
    expect(result.text).toMatch(/rbr_.*abcd/);
    expect(result.text).toMatch(/\*{4,}/);
  });

  it('flags inactive when another plugin owns the slot', async () => {
    const api = buildApi('memory-lancedb');
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(ctxWithArgs('status'));
    expect(result.text).toMatch(/memory-lancedb \(INACTIVE/);
  });

  it('shows project_slug when set in config', async () => {
    const api = buildApi();
    registerCommands(api, { ...CONFIG, projectSlug: 'my-project' });
    const result = await api.cmd.handler(ctxWithArgs('status'));
    expect(result.text).toMatch(/project_slug:\s+my-project/);
  });

  it('shows fallback hint when project_slug is null', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(ctxWithArgs('status'));
    expect(result.text).toMatch(/project_slug:\s+<from \.rembric per cwd>/);
  });

  it('surfaces registrationMode so operators can diagnose noop modes', async () => {
    const api = buildApi('rembric', 'setup-only');
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(ctxWithArgs('status'));
    expect(result.text).toMatch(/registrationMode:\s+setup-only/);
  });

  it('returns text-only ReplyPayload for unknown subcommands', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(ctxWithArgs('unknown-sub'));
    expect(result.text).toMatch(/unknown subcommand/);
  });
});
