import { describe, expect, it } from 'vitest';

import { ConfigError, findStaleEnvVars, loadConfig } from './config.js';

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { REMBRIC_ADMIN_TOKEN: 'long-enough-admin-token-1234567890', ...extra };
}

describe('loadConfig — defaults', () => {
  it('uses sensible defaults', () => {
    const config = loadConfig(env());
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe('info');
    expect(config.embedding.provider).toBe('openai');
    expect(config.embedding.baseUrl).toBe('http://localhost:11434/v1');
    expect(config.embedding.enabled).toBe(true);
    expect(config.judgments.orphanAfterMs).toBe(86_400_000);
    expect(config.judgments.orphanDeadlineMs).toBe(14 * 86_400_000);
  });
});

describe('loadConfig — types and ranges', () => {
  it('parses REMBRIC_PORT from string', () => {
    const config = loadConfig(env({ REMBRIC_PORT: '9999' }));
    expect(config.port).toBe(9999);
  });

  it('rejects out-of-range REMBRIC_PORT', () => {
    expect(() => loadConfig(env({ REMBRIC_PORT: '70000' }))).toThrow(ConfigError);
  });

  it('rejects malformed OPENAI_BASE_URL', () => {
    expect(() => loadConfig(env({ OPENAI_BASE_URL: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('coerces EMBEDDING_ENABLED from string', () => {
    const off = loadConfig(env({ EMBEDDING_ENABLED: 'false' }));
    expect(off.embedding.enabled).toBe(false);
    const on = loadConfig(env({ EMBEDDING_ENABLED: 'true' }));
    expect(on.embedding.enabled).toBe(true);
  });

  it('rejects out-of-range JUDGMENT_ORPHAN_DEADLINE_MS', () => {
    expect(() => loadConfig(env({ JUDGMENT_ORPHAN_DEADLINE_MS: '1000' }))).toThrow(ConfigError);
  });
});

describe('loadConfig — removed env vars degrade gracefully', () => {
  // Upgrade contract of `remove-llm-consolidation`: a ≤0.20 environment
  // still defining chat-LLM / cron vars boots normally; the names are
  // surfaced once via findStaleEnvVars for the boot warning.
  const stale = {
    LLM_PROVIDER: 'openai',
    OPENAI_MODEL: 'qwen2.5:7b',
    CONSOLIDATION_ENABLED: 'true',
    CONSOLIDATION_CRON: '0 3 * * *',
    CONSOLIDATION_BATCH_SIZE: '50',
  };

  it('boots with every removed var still set', () => {
    const config = loadConfig(env({ ...stale, OPENAI_API_KEY: 'sk-test' }));
    expect(config.port).toBe(8787);
    expect(config.embedding.apiKey).toBe('sk-test');
  });

  it('findStaleEnvVars names exactly the removed vars present', () => {
    expect(findStaleEnvVars(env(stale))).toEqual([
      'LLM_PROVIDER',
      'OPENAI_MODEL',
      'CONSOLIDATION_ENABLED',
      'CONSOLIDATION_CRON',
      'CONSOLIDATION_BATCH_SIZE',
    ]);
    expect(findStaleEnvVars(env())).toEqual([]);
  });

  it('no longer requires OPENAI_API_KEY under any combination', () => {
    const config = loadConfig(env({ EMBEDDING_ENABLED: 'true', OPENAI_API_KEY: '' }));
    expect(config.embedding.apiKey).toBeNull();
  });
});
