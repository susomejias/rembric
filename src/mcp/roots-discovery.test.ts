import { describe, expect, it } from 'vitest';

import { deriveSlugFromUri } from './roots-discovery.js';

describe('deriveSlugFromUri', () => {
  it('extracts the basename from a file:// URI', () => {
    expect(deriveSlugFromUri('file:///home/me/rembric')).toBe('rembric');
    expect(deriveSlugFromUri('file:///Users/x/repos/web-api')).toBe('web-api');
  });

  it('lowercases mixed-case directory names', () => {
    expect(deriveSlugFromUri('file:///home/me/Mi-Proyecto')).toBe('mi-proyecto');
  });

  it('replaces non-[a-z0-9-] characters with hyphens', () => {
    expect(deriveSlugFromUri('file:///home/me/My.Proj.v2')).toBe('my-proj-v2');
    expect(deriveSlugFromUri('file:///home/me/foo_bar')).toBe('foo-bar');
  });

  it('collapses runs of hyphens and trims edges', () => {
    expect(deriveSlugFromUri('file:///home/me/__weird__name__')).toBe('weird-name');
    expect(deriveSlugFromUri('file:///home/me/--leading--trailing--')).toBe('leading-trailing');
  });

  it('accepts plain paths without the file:// prefix', () => {
    expect(deriveSlugFromUri('/home/me/rembric')).toBe('rembric');
  });

  it('returns null for empty / unusable basenames', () => {
    expect(deriveSlugFromUri('file:///')).toBe(null);
    expect(deriveSlugFromUri('')).toBe(null);
    expect(deriveSlugFromUri('file:///home/me/!!!')).toBe(null);
  });

  it('rejects slugs longer than 64 characters', () => {
    const long = 'a'.repeat(70);
    expect(deriveSlugFromUri(`file:///tmp/${long}`)).toBe(null);
  });

  it('strips trailing slashes', () => {
    expect(deriveSlugFromUri('file:///home/me/rembric/')).toBe('rembric');
  });
});
