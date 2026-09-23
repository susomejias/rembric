import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOCKER_SOCKET,
  DockerEngineApi,
  EngineApiError,
  ENGINE_API_VERSION,
} from '../services/self-update/engine-api.js';

import { deriveCreatePayload, parseHealthTimeoutMs, runUpgrade } from './upgrade-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const helperSource = readFileSync(join(here, 'upgrade-helper.ts'), 'utf8');

const ENGINE_METHODS = [
  'inspectContainer',
  'createContainer',
  'startContainer',
  'stopContainer',
  'renameContainer',
  'removeContainer',
  'pullImage',
] as const;

describe('cross-version upgrader reuses the canonical engine-api', () => {
  it('imports the shared client instead of shipping a private copy', () => {
    expect(helperSource).toContain("from '../services/self-update/engine-api.js'");
    expect(helperSource).not.toMatch(/class\s+DockerEngineApi\b/);
  });

  it('exposes the engine surface the compat helper drives', () => {
    const api = new DockerEngineApi();
    for (const method of ENGINE_METHODS) {
      expect(typeof api[method]).toBe('function');
    }
    expect(DEFAULT_DOCKER_SOCKET).toBe('/var/run/docker.sock');
    expect(ENGINE_API_VERSION).toBe('v1.41');
    expect(new EngineApiError('boom', null)).toBeInstanceOf(Error);
  });

  it('keeps the exported compat surface callable', () => {
    expect(typeof deriveCreatePayload).toBe('function');
    expect(typeof parseHealthTimeoutMs).toBe('function');
    expect(typeof runUpgrade).toBe('function');
  });
});
