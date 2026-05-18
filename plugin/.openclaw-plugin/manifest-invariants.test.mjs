import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'openclaw.plugin.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

describe('openclaw.plugin.json invariants', () => {
  it('declares id="rembric" and kind="memory"', () => {
    expect(manifest.id).toBe('rembric');
    expect(manifest.kind).toBe('memory');
  });

  it('lists all 17 memory_*/project_* tools in contracts.tools', () => {
    expect(manifest.contracts?.tools).toEqual([
      'memory_save',
      'memory_search',
      'memory_get',
      'memory_judge',
      'memory_confirm',
      'memory_compare',
      'memory_context',
      'memory_timeline',
      'memory_stats',
      'memory_session_start',
      'memory_session_end',
      'memory_session_summary',
      'memory_save_prompt',
      'memory_capture_passive',
      'project_current',
      'project_list',
      'project_use',
    ]);
  });

  it('declares required configSchema fields', () => {
    expect(manifest.configSchema?.required).toEqual(['server_url', 'api_token']);
    expect(manifest.configSchema?.additionalProperties).toBe(false);
    const props = manifest.configSchema?.properties || {};
    expect(props.server_url?.type).toBe('string');
    expect(props.api_token?.type).toBe('string');
    expect(props.autoRecall?.default).toBe(true);
    expect(props.autoCapture?.default).toBe(false);
    expect(typeof props.tokenBudget?.default).toBe('number');
  });

  it('marks api_token as secret via configContracts.secretInputs', () => {
    const paths = manifest.configContracts?.secretInputs?.paths || [];
    expect(paths.some((p) => p.path === 'api_token')).toBe(true);
  });

  it('marks api_token sensitive via uiHints', () => {
    expect(manifest.uiHints?.api_token?.sensitive).toBe(true);
  });

  it('package.json::openclaw.extensions points at ./plugin.mjs', () => {
    expect(pkg.openclaw?.extensions).toEqual(['./plugin.mjs']);
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
  });

  it('package.json::version matches openclaw.plugin.json::version', () => {
    expect(pkg.version).toBe(manifest.version);
  });
});

describe('no bundle markers / build artifacts under plugin/.openclaw-plugin/', () => {
  const forbidden = [
    'mcp.json',
    '.mcp.json',
    'hooks.json',
    'hooks.codex.json',
    'tsconfig.json',
    'tsdown.config.ts',
    'tsdown.config.mjs',
    'dist',
  ];

  for (const name of forbidden) {
    it(`does not contain ${name}`, () => {
      expect(existsSync(path.join(__dirname, name))).toBe(false);
    });
  }
});
