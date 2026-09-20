import { describe, expect, it } from 'vitest';

import { parseRequestUrl, tryParseJson, tryParseUrl } from './parse.js';

describe('dashboard parse helpers', () => {
  it('tryParseUrl reports a malformed url as null and parses a well-formed one', () => {
    expect(tryParseUrl('not-a-url')).toBeNull();
    expect(tryParseUrl('https://x/dashboard/memories?page=2')?.searchParams.get('page')).toBe('2');
  });

  it('parseRequestUrl reads the inbound request url and reports a malformed one as null', () => {
    expect(parseRequestUrl({ req: { url: 'not-a-url' } })).toBeNull();
    expect(parseRequestUrl({ req: { url: 'https://x/dashboard/tokens' } })?.pathname).toBe(
      '/dashboard/tokens',
    );
  });

  it('tryParseJson reports unparseable stored text as a failure and parses valid JSON', () => {
    expect(tryParseJson('{"archives":2,"orphaned":1}')).toEqual({
      ok: true,
      value: { archives: 2, orphaned: 1 },
    });
    expect(tryParseJson('legacy prose summary')).toEqual({ ok: false });
    expect(tryParseJson('{not json')).toEqual({ ok: false });
    // A literal JSON `null` parses successfully — a failure is never mistaken for it.
    expect(tryParseJson('null')).toEqual({ ok: true, value: null });
  });
});
