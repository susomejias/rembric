import { describe, expect, it } from 'vitest';

import { buildInstructions, INSTRUCTIONS_MAX_LENGTH } from './instructions.js';

describe('MCP initialize instructions', () => {
  it('emits ≤ 800 characters for the unscoped variant', () => {
    const text = buildInstructions({ requestedSlug: null });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it('emits ≤ 800 characters for the path-scoped variant', () => {
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

  it('mentions the path-scoped slug in the path-scoped variant', () => {
    const text = buildInstructions({ requestedSlug: 'rembric-api' });
    expect(text).toContain("'rembric-api'");
    expect(text).toContain('scope=');
  });

  it('points unscoped connections at project.use / roots auto-detection', () => {
    const text = buildInstructions({ requestedSlug: null });
    expect(text).toContain('project.use');
    expect(text).toContain('roots');
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
      expect(text).toContain('before');
    }
  });
});
