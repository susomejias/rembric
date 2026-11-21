import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DECLARED_SESSION_HEADER, readDeclaredSessionHeader } from './mcp-auth';

const layout = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'plugin',
      'test',
      'host-binding-layout.json',
    ),
    'utf8',
  ),
) as { header: string; sessionIdPattern: string };

function headers(value?: string): Headers {
  const h = new Headers();
  if (value !== undefined) h.set(DECLARED_SESSION_HEADER, value);
  return h;
}

describe('readDeclaredSessionHeader', () => {
  it('reads the header the shared host-binding layout names', () => {
    expect(DECLARED_SESSION_HEADER.toLowerCase()).toBe(layout.header.toLowerCase());
  });

  it.each(['abcdefgh', 'A'.repeat(128), '01M8015K5KE2RCVZWH6XAXF3GS', 'claude_session-01'])(
    'returns %j, which the layout pattern accepts',
    (value) => {
      expect(new RegExp(layout.sessionIdPattern).test(value)).toBe(true);
      expect(readDeclaredSessionHeader(headers(value))).toBe(value);
    },
  );

  it.each([
    'abcdefg',
    'A'.repeat(129),
    '',
    'has space id',
    'abcdefgh, ijklmnop',
    'abcdefgh!',
    'sessión-abcdef',
  ])('ignores malformed %j instead of refusing', (value) => {
    expect(new RegExp(layout.sessionIdPattern).test(value)).toBe(false);
    expect(readDeclaredSessionHeader(headers(value))).toBeUndefined();
  });

  it('is undefined when the header is absent', () => {
    expect(readDeclaredSessionHeader(headers())).toBeUndefined();
  });

  it('ignores two header instances', () => {
    const h = new Headers();
    h.append(DECLARED_SESSION_HEADER, 'abcdefgh');
    h.append(DECLARED_SESSION_HEADER, 'ijklmnop');
    expect(readDeclaredSessionHeader(h)).toBeUndefined();
  });
});
