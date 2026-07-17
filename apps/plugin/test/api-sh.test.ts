import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiSh = join(here, '..', 'scripts', '_api.sh');

/** Source _api.sh, call one function with args, print its stdout. */
function callFn(fn: string, ...args: string[]): string {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return execFileSync('bash', ['-c', `source '${apiSh}'; ${fn} ${quoted}`], { encoding: 'utf8' });
}

describe('rembric_parse_dotenv (#260)', () => {
  function parse(content: string): Record<string, string> {
    const file = execFileSync('bash', ['-c', 'f=$(mktemp); cat > "$f"; echo "$f"'], {
      input: content,
      encoding: 'utf8',
    }).trim();
    const out = callFn('rembric_parse_dotenv', file);
    execFileSync('rm', ['-f', file]);
    const result: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  }

  it('trims trailing whitespace from a value', () => {
    const result = parse('PROJECT_SLUG=myproj   \n');
    expect(result.PROJECT_SLUG).toBe('myproj');
  });

  it('strips a trailing CR from a CRLF-saved file', () => {
    const result = parse('PROJECT_SLUG=myproj\r\n');
    expect(result.PROJECT_SLUG).toBe('myproj');
  });

  it('strips trailing CR and whitespace together', () => {
    const result = parse('PROJECT_SLUG=myproj  \r\n');
    expect(result.PROJECT_SLUG).toBe('myproj');
  });

  it('still trims leading whitespace (pre-existing behavior, unaffected)', () => {
    const result = parse('PROJECT_SLUG=   myproj\n');
    expect(result.PROJECT_SLUG).toBe('myproj');
  });

  it('leaves an already-clean value untouched', () => {
    const result = parse('PROJECT_SLUG=myproj\n');
    expect(result.PROJECT_SLUG).toBe('myproj');
  });
});

describe('rembric_json_escape (#260)', () => {
  function escape(input: string): string {
    return callFn('rembric_json_escape', input);
  }

  function parseAsJsonString(escaped: string): string {
    return JSON.parse(`"${escaped}"`) as string;
  }

  it('still escapes backslash, quote, \\n \\r \\t exactly as before', () => {
    const out = escape('a\\b"c\nd\re\tf');
    expect(parseAsJsonString(out)).toBe('a\\b"c\nd\re\tf');
  });

  it('escapes an ANSI escape byte (\\x1b) so the result is valid JSON', () => {
    const input = 'before\x1bafter';
    const out = escape(input);
    expect(out).toBe('before\\u001bafter');
    expect(parseAsJsonString(out)).toBe(input);
  });

  it('escapes other C0 control bytes (e.g. \\x01, \\x0b, \\x1f)', () => {
    const input = 'a\x01b\x0bc\x1fd';
    const out = escape(input);
    expect(out).toBe('a\\u0001b\\u000bc\\u001fd');
    expect(parseAsJsonString(out)).toBe(input);
  });

  it('does not touch DEL (\\x7f) — outside the JSON-mandated escape range', () => {
    const input = 'a\x7fb';
    const out = escape(input);
    expect(out).toBe('a\x7fb');
  });

  it('round-trips a mix of ordinary text and control bytes through real JSON parsing', () => {
    const input = 'line1\nline2\x1b[31mred\x1b[0m\tend';
    const out = escape(input);
    expect(parseAsJsonString(out)).toBe(input);
  });
});
