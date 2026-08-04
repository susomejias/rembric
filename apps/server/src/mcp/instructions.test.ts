import { describe, expect, it } from 'vitest';

import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';

import { buildInstructions, INSTRUCTIONS_MAX_LENGTH } from './instructions.js';

describe('MCP initialize instructions', () => {
  it('emits ≤ 1000 characters for the unscoped variant', () => {
    const text = buildInstructions({ requestedSlug: null });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it('emits ≤ 1000 characters for the path-scoped variant', () => {
    const text = buildInstructions({ requestedSlug: 'rembric' });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it('mentions memory.save, memory.search, memory.session_summary in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('memory.save');
      expect(text).toContain('memory.search');
      expect(text).toContain('memory.session_summary');
    }
  });

  it('mentions the path-scoped slug in the path-scoped variant, and names no retired scope', () => {
    const text = buildInstructions({ requestedSlug: 'rembric-api' });
    expect(text).toContain("'rembric-api'");
    expect(text).toContain('project');
    expect(text).not.toMatch(/global|user-wide/i);
  });

  it('tells an unscoped connection a project is always active, names the default project, and names no retired scope', () => {
    const text = buildInstructions({ requestedSlug: null });
    expect(text).toContain('always active');
    expect(text).toContain('default project');
    expect(text).toContain('project.use');
    expect(text).toContain('roots');
    expect(text).not.toMatch(/global|user-wide/i);
  });

  it('does not reference the removed X-Rembric-Project header', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).not.toContain('X-Rembric-Project');
    }
  });

  it('teaches the session-close protocol with title in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('memory.session_summary');
      expect(text).toContain('title');
      expect(text.toLowerCase()).toContain('before');
    }
  });

  it('surfaces the summary length cap inline in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain(String(SUMMARY_MAX_CHARS));
    }
  });

  it('teaches the post-compact recovery path (memory.context) in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('memory.context');
    }
  });

  it('binds the session-summary trigger to ending a working turn, not the literal word "done"', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('Before ending');
      expect(text).not.toContain('before saying "done"');
    }
  });

  it('keeps recall on-demand rather than unconditional at session start', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('memory.context');
      expect(text).toContain('if you lack prior detail');
    }
  });

  it('points at memory.about for update guidance in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('memory.about');
    }
  });
});
