import { buildAboutReport, createAboutHandler } from '@rembric/mcp';
import { describe, expect, it } from 'vitest';

import { REMBRIC_VERSION } from '../../version.js';

const CANONICAL_INSTALLER = 'https://raw.githubusercontent.com/susomejias/rembric/main/install.sh';

describe('memory.about report', () => {
  it('reports the running server version', () => {
    expect(buildAboutReport(REMBRIC_VERSION).server.version).toBe(REMBRIC_VERSION);
  });

  it('returns both axes', () => {
    const r = buildAboutReport(REMBRIC_VERSION);
    expect(r.server).toBeDefined();
    expect(r.plugins).toBeDefined();
  });

  it('states the server cannot see client plugins on the plugins axis', () => {
    expect(buildAboutReport(REMBRIC_VERSION).plugins.note.toLowerCase()).toContain('cannot see');
  });

  it('derives plugin commands from the canonical installer entrypoint and flags', () => {
    const { interactive, update_all, subset } = buildAboutReport(REMBRIC_VERSION).plugins;
    expect(interactive).toContain(CANONICAL_INSTALLER);
    expect(update_all).toContain(CANONICAL_INSTALLER);
    expect(update_all).toContain('--action=update');
    expect(subset).toContain('--action=update');
    expect(subset).toContain('--agent=');
  });

  it('offers a read-only status command for checking before updating', () => {
    const { status, note } = buildAboutReport(REMBRIC_VERSION).plugins;
    expect(status).toContain(CANONICAL_INSTALLER);
    expect(status).toContain('--status');
    expect(status).toContain('--json');
    expect(status).not.toContain('--action=update');
    expect(note.toLowerCase()).toContain('status');
  });

  it('does not present the server version as a plugin-freshness indicator', () => {
    expect(buildAboutReport(REMBRIC_VERSION).server.version).not.toMatch(/plugin/i);
  });

  it('is a pure function (repeat calls are equal)', () => {
    expect(buildAboutReport(REMBRIC_VERSION)).toEqual(buildAboutReport(REMBRIC_VERSION));
  });
});

describe('memory.about handler', () => {
  it('returns the report as MCP text content with no side effects', () => {
    const res = createAboutHandler(REMBRIC_VERSION)({});
    expect(res.content).toHaveLength(1);
    const [entry] = res.content;
    expect(entry?.type).toBe('text');
    const text = entry && 'text' in entry ? entry.text : '';
    expect(JSON.parse(text)).toEqual(buildAboutReport(REMBRIC_VERSION));
    expect(res.structuredContent).toEqual(buildAboutReport(REMBRIC_VERSION));
  });
});
