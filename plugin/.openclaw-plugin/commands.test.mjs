import { describe, it, expect } from 'vitest';
import { registerCommands } from './commands.mjs';

function buildApi(slotOwner = 'rembric') {
  let cmd;
  return {
    config: { plugins: { slots: { memory: slotOwner } } },
    registerCommand: (def) => {
      cmd = def;
    },
    logger: { warn: () => {}, debug: () => {} },
    get cmd() {
      return cmd;
    },
  };
}

const CONFIG = {
  serverUrl: 'https://memory.example.com',
  apiToken: 'rbr_12345678abcd',
  autoRecall: true,
  autoCapture: false,
  tokenBudget: 1800,
};

describe('registerCommands', () => {
  it('registers /rembric with status as default subcommand', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    expect(api.cmd?.name).toBe('rembric');
    const result = await api.cmd.handler([]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Rembric status/);
    expect(result.message).toMatch(/server_url:\s+https:\/\/memory\.example\.com/);
    expect(result.message).toMatch(/memory slot:\s+rembric \(active\)/);
  });

  it('masks the api token body', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(['status']);
    expect(result.message).not.toContain('rbr_12345678abcd');
    expect(result.message).toMatch(/rbr_.*abcd/);
    expect(result.message).toMatch(/\*{4,}/);
  });

  it('flags inactive when another plugin owns the slot', async () => {
    const api = buildApi('memory-lancedb');
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(['status']);
    expect(result.message).toMatch(/memory-lancedb \(INACTIVE/);
  });

  it('returns error message for unknown subcommands', async () => {
    const api = buildApi();
    registerCommands(api, CONFIG);
    const result = await api.cmd.handler(['unknown-sub']);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unknown subcommand/);
  });
});
