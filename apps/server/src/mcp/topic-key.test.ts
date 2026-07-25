import { describe, expect, it } from 'vitest';

import { suggestTopicKey } from './topic-key.js';

describe('suggestTopicKey — deterministic family + slug', () => {
  it('produces a stable slug for the same input', () => {
    const a = suggestTopicKey({ type: 'project', title: 'JWT auth middleware' });
    const b = suggestTopicKey({ type: 'project', title: 'JWT auth middleware' });
    expect(a).toBe(b);
  });

  it('maps type families', () => {
    expect(suggestTopicKey({ type: 'project', title: 'x' })).toMatch(/^decision\//);
    expect(suggestTopicKey({ type: 'user', title: 'x' })).toMatch(/^preference\//);
    expect(suggestTopicKey({ type: 'feedback', title: 'x' })).toMatch(/^feedback\//);
    expect(suggestTopicKey({ type: 'reference', title: 'x' })).toMatch(/^reference\//);
    expect(suggestTopicKey({ type: 'procedural', title: 'x' })).toMatch(/^runbook\//);
  });

  it('drops stopwords and joins surviving tokens', () => {
    expect(suggestTopicKey({ type: 'project', title: 'A note about the auth model' })).toBe(
      'decision/note-auth-model',
    );
  });

  it('caps at 6 tokens', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    const result = suggestTopicKey({ type: 'project', title: long });
    expect(result.split('/')[1]!.split('-').length).toBeLessThanOrEqual(6);
  });

  it('caps slug length at 48 chars and trims trailing hyphens', () => {
    const long = 'verylongword '.repeat(10);
    const result = suggestTopicKey({ type: 'project', title: long });
    const slug = result.split('/')[1] ?? '';
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to content when title is missing', () => {
    expect(suggestTopicKey({ type: 'feedback', content: 'use two-space indentation' })).toBe(
      'feedback/use-two-space-indentation',
    );
  });

  it('returns family/untitled for empty input', () => {
    expect(suggestTopicKey({ type: 'project', title: '' })).toBe('decision/untitled');
    expect(suggestTopicKey({ type: 'project' })).toBe('decision/untitled');
  });
});
