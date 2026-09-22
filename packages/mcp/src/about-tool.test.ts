import { describe, expect, it } from 'vitest';

import { buildAboutReport, createAboutHandler } from '@rembric/mcp';

const TEST_VERSION = '0.0.0-test';
const CANONICAL_INSTALLER = 'https://raw.githubusercontent.com/susomejias/rembric/main/install.sh';

describe('memory.about report', () => {
  it('reports the running server version', () => {
    expect(buildAboutReport(TEST_VERSION).server.version).toBe(TEST_VERSION);
  });

  it('returns both axes', () => {
    const r = buildAboutReport(TEST_VERSION);
    expect(r.server).toBeDefined();
    expect(r.plugins).toBeDefined();
  });

  it('states the server cannot see client plugins on the plugins axis', () => {
    expect(buildAboutReport(TEST_VERSION).plugins.note.toLowerCase()).toContain('cannot see');
  });

  it('derives plugin commands from the canonical installer entrypoint and flags', () => {
    const { interactive, update_all, subset } = buildAboutReport(TEST_VERSION).plugins;
    expect(interactive).toContain(CANONICAL_INSTALLER);
    expect(update_all).toContain(CANONICAL_INSTALLER);
    expect(update_all).toContain('--action=update');
    expect(subset).toContain('--action=update');
    expect(subset).toContain('--agent=');
  });

  it('offers a read-only status command for checking before updating', () => {
    const { status, note } = buildAboutReport(TEST_VERSION).plugins;
    expect(status).toContain(CANONICAL_INSTALLER);
    expect(status).toContain('--status');
    expect(status).toContain('--json');
    expect(status).not.toContain('--action=update');
    expect(note.toLowerCase()).toContain('status');
  });

  it('does not present the server version as a plugin-freshness indicator', () => {
    expect(buildAboutReport(TEST_VERSION).server.version).not.toMatch(/plugin/i);
  });

  it('is a pure function (repeat calls are equal)', () => {
    expect(buildAboutReport(TEST_VERSION)).toEqual(buildAboutReport(TEST_VERSION));
  });
});

describe('memory.about handler', () => {
  it('returns the report as MCP text content with no side effects', () => {
    const res = createAboutHandler(TEST_VERSION)({});
    expect(res.content).toHaveLength(1);
    const [entry] = res.content;
    expect(entry?.type).toBe('text');
    const text = entry && 'text' in entry ? entry.text : '';
    expect(JSON.parse(text)).toEqual(buildAboutReport(TEST_VERSION));
    expect(res.structuredContent).toEqual(buildAboutReport(TEST_VERSION));
  });
});
