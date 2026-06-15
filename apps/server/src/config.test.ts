import { describe, expect, it } from 'vitest';

import { ConfigError, findStaleEnvVars, loadConfig, REMOVED_ENV_VARS } from './config.js';

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { REMBRIC_ADMIN_TOKEN: 'long-enough-admin-token-1234567890', ...extra };
}

describe('loadConfig — defaults', () => {
  it('uses sensible defaults', () => {
    const config = loadConfig(env());
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe('info');
    expect(config.candidates.perSaveMax).toBe(5);
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

  it('rejects out-of-range JUDGMENT_ORPHAN_DEADLINE_MS', () => {
    expect(() => loadConfig(env({ JUDGMENT_ORPHAN_DEADLINE_MS: '1000' }))).toThrow(ConfigError);
  });
});

describe('loadConfig — OAuth', () => {
  it('is disabled by default', () => {
    const config = loadConfig(env());
    expect(config.oauth.enabled).toBe(false);
    expect(config.oauth.issuer).toBeNull();
    expect(config.oauth.accessTtlMs).toBe(3_600_000);
    expect(config.oauth.refreshTtlMs).toBe(30 * 86_400_000);
  });

  it('enables when REMBRIC_PUBLIC_URL is a valid https origin', () => {
    const config = loadConfig(env({ REMBRIC_PUBLIC_URL: 'https://rembric.example.com' }));
    expect(config.oauth.enabled).toBe(true);
    expect(config.oauth.issuer).toBe('https://rembric.example.com');
  });

  it('strips a trailing slash from the issuer', () => {
    const config = loadConfig(env({ REMBRIC_PUBLIC_URL: 'https://rembric.example.com/' }));
    expect(config.oauth.issuer).toBe('https://rembric.example.com');
  });

  it('rejects a non-https issuer on a public host', () => {
    expect(() => loadConfig(env({ REMBRIC_PUBLIC_URL: 'http://rembric.example.com' }))).toThrow(
      ConfigError,
    );
  });

  it('allows http for loopback hosts (local testing)', () => {
    for (const issuer of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
      const config = loadConfig(env({ REMBRIC_PUBLIC_URL: issuer }));
      expect(config.oauth.enabled).toBe(true);
      expect(config.oauth.issuer).toBe(issuer);
    }
  });

  it('rejects a non-URL issuer', () => {
    expect(() => loadConfig(env({ REMBRIC_PUBLIC_URL: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('parses custom TTLs (seconds) into ms', () => {
    const config = loadConfig(
      env({
        REMBRIC_PUBLIC_URL: 'https://rembric.example.com',
        REMBRIC_OAUTH_ACCESS_TTL: '900',
        REMBRIC_OAUTH_REFRESH_TTL: '604800',
      }),
    );
    expect(config.oauth.accessTtlMs).toBe(900_000);
    expect(config.oauth.refreshTtlMs).toBe(604_800_000);
  });
});

describe('loadConfig — removed env vars degrade gracefully', () => {
  // Upgrade contract (`remove-llm-consolidation` + `embed-embeddings-in-process`):
  // environments still defining chat-LLM, cron, or embedding-provider vars
  // boot normally; the names surface once via findStaleEnvVars for the
  // boot warning. No env var configures the engine.
  const stale: NodeJS.ProcessEnv = {
    LLM_PROVIDER: 'openai',
    OPENAI_MODEL: 'qwen2.5:7b',
    CONSOLIDATION_ENABLED: 'true',
    CONSOLIDATION_CRON: '0 3 * * *',
    CONSOLIDATION_BATCH_SIZE: '50',
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_EMBEDDING_MODEL: 'nomic-embed-text',
    EMBEDDING_PROVIDER: 'openai',
    EMBEDDING_ENABLED: 'true',
    CANDIDATE_VEC_THRESHOLD: '0.85',
    CANDIDATE_FTS_THRESHOLD: '0.4',
  };

  it('boots with every removed var still set', () => {
    const config = loadConfig(env(stale));
    expect(config.port).toBe(8787);
  });

  it('findStaleEnvVars names exactly the removed vars present', () => {
    expect(findStaleEnvVars(env(stale))).toEqual([...REMOVED_ENV_VARS]);
    expect(findStaleEnvVars(env())).toEqual([]);
  });

  it('the config carries no embedding or LLM surface at all', () => {
    const config = loadConfig(env());
    expect('embedding' in config).toBe(false);
    expect('llm' in config).toBe(false);
    expect('consolidation' in config).toBe(false);
  });
});
