import { describe, expect, it } from 'vitest';

import { applyListenPort, DEFAULT_PORT, resolveListenPort } from '../../server.js';

describe('standalone listen port derivation', () => {
  it('REMBRIC_PORT wins over the generated server PORT', () => {
    expect(resolveListenPort({ REMBRIC_PORT: '8799', PORT: '8787' })).toBe(8799);
  });

  it('falls back to PORT when REMBRIC_PORT is unset', () => {
    expect(resolveListenPort({ PORT: '9001' })).toBe(9001);
  });

  it('defaults to 8787 when neither variable is set', () => {
    expect(resolveListenPort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8787);
  });

  it('treats an empty or whitespace REMBRIC_PORT as unset and keeps the default', () => {
    expect(resolveListenPort({ REMBRIC_PORT: '', PORT: '' })).toBe(DEFAULT_PORT);
    expect(resolveListenPort({ REMBRIC_PORT: '  ' })).toBe(DEFAULT_PORT);
  });

  it.each(['abc', '87.5', '-1', '0', '65536', '8787x'])(
    'fails fast on an unusable REMBRIC_PORT (%s) instead of silently falling back',
    (value) => {
      expect(() => resolveListenPort({ REMBRIC_PORT: value, PORT: '8787' })).toThrow(
        /REMBRIC_PORT must be an integer between 1 and 65535/,
      );
    },
  );

  it('publishes the resolved port as PORT for the generated server before it loads', () => {
    const env: Record<string, string | undefined> = { REMBRIC_PORT: '8799', PORT: '8787' };
    expect(applyListenPort(env)).toBe(8799);
    expect(env.PORT).toBe('8799');
  });
});
