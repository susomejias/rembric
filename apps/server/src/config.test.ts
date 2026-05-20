import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { REMBRIC_ADMIN_TOKEN: 'long-enough-admin-token-1234567890', ...extra };
}

describe('loadConfig — defaults', () => {
  it('uses sensible defaults', () => {
    const config = loadConfig(env({ CONSOLIDATION_ENABLED: 'false' }));
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe('info');
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.baseUrl).toBe('http://localhost:11434/v1');
    expect(config.embedding.enabled).toBe(true);
    expect(config.consolidation.cron).toBe('0 3 * * *');
  });
});

describe('loadConfig — types and ranges', () => {
  it('parses REMBRIC_PORT from string', () => {
    const config = loadConfig(env({ REMBRIC_PORT: '9999', CONSOLIDATION_ENABLED: 'false' }));
    expect(config.port).toBe(9999);
  });

  it('rejects out-of-range REMBRIC_PORT', () => {
    expect(() =>
      loadConfig(env({ REMBRIC_PORT: '70000', CONSOLIDATION_ENABLED: 'false' })),
    ).toThrow(ConfigError);
  });

  it('rejects malformed OPENAI_BASE_URL', () => {
    expect(() =>
      loadConfig(env({ OPENAI_BASE_URL: 'not-a-url', CONSOLIDATION_ENABLED: 'false' })),
    ).toThrow(ConfigError);
  });

  it('coerces EMBEDDING_ENABLED from string', () => {
    const off = loadConfig(env({ EMBEDDING_ENABLED: 'false', CONSOLIDATION_ENABLED: 'false' }));
    expect(off.embedding.enabled).toBe(false);
    const on = loadConfig(env({ EMBEDDING_ENABLED: 'true', CONSOLIDATION_ENABLED: 'false' }));
    expect(on.embedding.enabled).toBe(true);
  });
});

describe('loadConfig — consolidation gating', () => {
  it('requires OPENAI_API_KEY when CONSOLIDATION_ENABLED=true', () => {
    expect(() =>
      loadConfig(
        env({ CONSOLIDATION_ENABLED: 'true', OPENAI_API_KEY: '', EMBEDDING_ENABLED: 'false' }),
      ),
    ).toThrow(/OPENAI_API_KEY.*required when CONSOLIDATION_ENABLED=true/);
  });

  it('accepts a non-empty OPENAI_API_KEY when CONSOLIDATION_ENABLED=true', () => {
    const config = loadConfig(
      env({
        CONSOLIDATION_ENABLED: 'true',
        OPENAI_API_KEY: 'sk-test',
        EMBEDDING_ENABLED: 'false',
      }),
    );
    expect(config.llm.apiKey).toBe('sk-test');
  });

  it('does not require OPENAI_API_KEY when CONSOLIDATION_ENABLED=false', () => {
    const config = loadConfig(env({ CONSOLIDATION_ENABLED: 'false', OPENAI_API_KEY: '' }));
    expect(config.llm.apiKey).toBeNull();
  });

  it('requires OPENAI_API_KEY for embeddings when both enabled', () => {
    expect(() =>
      loadConfig(
        env({
          CONSOLIDATION_ENABLED: 'true',
          EMBEDDING_ENABLED: 'true',
          OPENAI_API_KEY: '',
        }),
      ),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
