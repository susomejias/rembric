import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiSh = join(here, '..', 'scripts', '_api.sh');

/** Source _api.sh, call one function with args, print its stdout. */
function callFn(fn: string, ...args: string[]): string {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return execFileSync('bash', ['-c', `source '${apiSh}'; ${fn} ${quoted}`], { encoding: 'utf8' });
}

/**
 * Same, but with an explicit TMPDIR, and returns the function's OWN exit
 * status as a boolean. `_api.sh` sets `trap 'exit 0' ERR` for every hook
 * script it's sourced into, so a bare (unconditional) call to a function
 * that legitimately returns non-zero (rembric_resumed_peek's "not resumed"
 * case) would trip that trap and force the WHOLE invocation to exit 0,
 * masking the real result. Wrapping the call in `if …; then …; else …; fi`
 * is what every real caller does too (prompt-nudge.sh's `if … &&
 * rembric_resumed_peek …; then`), so this mirrors the actual call shape.
 */
function callFnIn(tmp: string, fn: string, ...args: string[]): boolean {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const script = `source '${apiSh}'; if ${fn} ${quoted}; then echo OK; else echo NO; fi`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  });
  return result.stdout.trim() === 'OK';
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

describe('rembric_resumed_mark / rembric_resumed_peek (marker-directory mechanics)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rembric-resumedmark-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('peek is false before anything is recorded', () => {
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-none')).toBe(false);
  });

  it('a mark of created=false makes peek succeed', () => {
    callFnIn(tmp, 'rembric_resumed_mark', 's-a', 'false');
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-a')).toBe(true);
  });

  it('a mark of created=true leaves peek failing', () => {
    callFnIn(tmp, 'rembric_resumed_mark', 's-b', 'true');
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-b')).toBe(false);
  });

  it('a mark with an empty/unknown created value leaves peek failing (unknown = do-not-advise)', () => {
    callFnIn(tmp, 'rembric_resumed_mark', 's-c', '');
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-c')).toBe(false);
  });

  it('the FIRST mark wins — a later mark for the same id cannot flip the decision', () => {
    callFnIn(tmp, 'rembric_resumed_mark', 's-d', 'true');
    // Control: a later ensure for the same id now sees created:false, which
    // is what happens once the row exists — the mark must not overwrite.
    callFnIn(tmp, 'rembric_resumed_mark', 's-d', 'false');
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-d')).toBe(false);
  });

  it('marks for different session ids are independent', () => {
    callFnIn(tmp, 'rembric_resumed_mark', 's-e1', 'false');
    callFnIn(tmp, 'rembric_resumed_mark', 's-e2', 'true');
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-e1')).toBe(true);
    expect(callFnIn(tmp, 'rembric_resumed_peek', 's-e2')).toBe(false);
  });

  it('fails closed (peek false) when the marker directory cannot be created', () => {
    const notADir = join(tmp, 'this-is-a-file-not-a-dir');
    writeFileSync(notADir, '');
    callFnIn(notADir, 'rembric_resumed_mark', 's-f', 'false');
    expect(callFnIn(notADir, 'rembric_resumed_peek', 's-f')).toBe(false);
  });

  it('is a no-op for an empty session id', () => {
    callFnIn(tmp, 'rembric_resumed_mark', '', 'false');
    expect(callFnIn(tmp, 'rembric_resumed_peek', '')).toBe(false);
  });
});

describe('rembric_first_prompt_write / _take (the provisional title travels once)', () => {
  let tmp: string;

  /** Same shape as `callFn`, but with the TMPDIR the marker directory lives under. */
  function callIn(tmpdir: string, script: string): string {
    return execFileSync('bash', ['-c', `source '${apiSh}'; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmpdir },
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rembric-firstprompt-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('a take is followed by nothing, even when a later prompt tries to record one', () => {
    expect(callIn(tmp, `rembric_first_prompt_write s-1 'the first prompt'`)).toBe('');
    // Control: the recorded value IS delivered once, so an empty second take
    // cannot be an artefact of the write never landing.
    expect(callIn(tmp, `rembric_first_prompt_take s-1`)).toBe('the first prompt');
    callIn(tmp, `rembric_first_prompt_write s-1 'a later prompt'`);
    expect(callIn(tmp, `rembric_first_prompt_take s-1`)).toBe('');
    callIn(tmp, `rembric_first_prompt_write s-1 'a third prompt'`);
    expect(callIn(tmp, `rembric_first_prompt_take s-1`)).toBe('');
  });

  it('the FIRST prompt wins before consumption — a second write does not replace it', () => {
    callIn(tmp, `rembric_first_prompt_write s-2 'first'`);
    callIn(tmp, `rembric_first_prompt_write s-2 'second'`);
    expect(callIn(tmp, `rembric_first_prompt_take s-2`)).toBe('first');
  });

  it('rembric_first_prompt_recorded is false before, true while pending, true after consumption', () => {
    expect(callFnIn(tmp, 'rembric_first_prompt_recorded', 's-3')).toBe(false);
    callIn(tmp, `rembric_first_prompt_write s-3 'p'`);
    expect(callFnIn(tmp, 'rembric_first_prompt_recorded', 's-3')).toBe(true);
    callIn(tmp, `rembric_first_prompt_take s-3`);
    expect(callFnIn(tmp, 'rembric_first_prompt_recorded', 's-3')).toBe(true);
  });

  it('sessions are independent — consuming one does not silence another', () => {
    callIn(tmp, `rembric_first_prompt_write s-a 'prompt a'`);
    callIn(tmp, `rembric_first_prompt_write s-b 'prompt b'`);
    expect(callIn(tmp, `rembric_first_prompt_take s-a`)).toBe('prompt a');
    expect(callIn(tmp, `rembric_first_prompt_take s-b`)).toBe('prompt b');
  });
});
