import { describe, expect, it } from 'vitest';

import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';

import { buildInstructions, INSTRUCTIONS_MAX_LENGTH } from './instructions.js';
import { SUMMARY_MERGE_RULE, SUMMARY_SECTIONS } from './summary-rubric.js';

describe('MCP initialize instructions', () => {
  it('emits ≤ 1000 characters for the unscoped variant', () => {
    const text = buildInstructions({ requestedSlug: null });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it('emits ≤ 1000 characters for the path-scoped variant', () => {
    const text = buildInstructions({ requestedSlug: 'rembric' });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it('carries the exact Markdown summary headings on separate lines in both variants', () => {
    const headings = [
      '## Goal',
      '## Accomplished',
      '## Decisions+why',
      '## Verified+how',
      '## Unfinished+why',
      '## Files',
    ];
    for (const text of [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ]) {
      expect(text).toContain(SUMMARY_SECTIONS);
      expect(text).not.toContain(
        'Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files',
      );
      expect(text).toContain(headings.join('\n'));
    }
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

  it('states the section-wise merge clause, from the shared constant, in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain(SUMMARY_MERGE_RULE);
      expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
    }
  });

  it('asks for the current state, current first, in both variants', () => {
    const variants = [
      buildInstructions({ requestedSlug: null }),
      buildInstructions({ requestedSlug: 'rembric' }),
    ];
    for (const text of variants) {
      expect(text).toContain('Current state first');
    }
  });
});
