import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiSh = join(here, '..', 'scripts', '_api.sh');
const scripts = join(here, '..', 'scripts');

/** Hides jq from a sourced function without touching PATH, which bash rewrites. */
const HIDE_JQ = `command() { [ "$2" = jq ] && return 1; builtin command "$@"; }`;

const realSed = spawnSync('sh', ['-c', 'command -v sed'], { encoding: 'utf8' }).stdout.trim();
/** GNU sed only; where it is missing the POSIX-BRE arm cannot be exercised here. */
const posixSedAvailable =
  spawnSync(realSed, ['--posix', '-n', 's/a/b/p'], { input: 'a', encoding: 'utf8' }).status === 0;

/** Drops a `sed` on PATH that forces POSIX BREs, the way a BSD sed behaves. */
function writePosixSedShim(bin: string): void {
  writeFileSync(join(bin, 'sed'), `#!/bin/sh\nexec ${realSed} --posix "$@"\n`, { mode: 0o755 });
}

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

describe('rembric_turn_report — the notice decodes with and without jq', () => {
  // One array element carrying the notice's embedded newlines and quotes,
  // exactly the shape the server composes.
  const NOTICE =
    'rembric: refresh it.\nStored for "my session" (sizes, not targets):\n## Goal (9c)';
  const RESPONSE = JSON.stringify({ ok: true, sessionId: 's', lines: [NOTICE] });
  // Hides jq from `rembric_turn_report` without touching PATH, which bash
  // rewrites on this host. Anything else `command` is asked stays real.

  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'rbr-nojq-'));
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n200' '${RESPONSE}'\n`, {
      mode: 0o755,
    });
  });

  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  function report(prelude = ''): string {
    const script = `source '${apiSh}'; ${prelude}\nrembric_turn_report /api/demo/sessions/s/turn '{"usedTools":true}'`;
    return execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        REMBRIC_SERVER_URL: 'http://127.0.0.1:1',
        REMBRIC_API_TOKEN: 'tok',
      },
    });
  }

  it('emits the notice as real lines when jq is absent', () => {
    // The probe's own control: the override really does hide jq.
    expect(
      spawnSync('bash', ['-c', `${HIDE_JQ} command -v jq`], { encoding: 'utf8' }).status,
    ).not.toBe(0);
    expect(report(HIDE_JQ)).toBe(`${NOTICE}\n`);
  });

  it('control: jq on the same input produces the same bytes', () => {
    expect(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status).toBe(0);
    expect(report()).toBe(`${NOTICE}\n`);
  });
});

describe('rembric_turn_report — a lines-less body must not abort the caller', () => {
  // `_api.sh` installs `trap 'exit 0' ERR`, so a non-zero return from the
  // function's LAST statement kills the hook at `LINES="$(rembric_turn_report
  // …)"` — stop-report.sh then never reaches `_emit_nothing`, and Codex,
  // which requires a `{}` on stdout, gets nothing.
  const AFTER = 'REACHED-NEXT-STATEMENT';

  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'rbr-turnrc-'));
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  /** Runs the real call-site shape and reports whether the NEXT statement ran. */
  function reachesNextStatement(responseBody: string, prelude: string): boolean {
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n200' '${responseBody}'\n`, {
      mode: 0o755,
    });
    const script = [
      `source '${apiSh}'`,
      prelude,
      `LINES="$(rembric_turn_report /api/demo/sessions/s/turn '{"usedTools":true}')"`,
      `printf '%s' "${AFTER}"`,
    ].join('\n');
    const out = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        REMBRIC_SERVER_URL: 'http://127.0.0.1:1',
        REMBRIC_API_TOKEN: 'tok',
      },
    });
    return out.stdout.includes(AFTER);
  }

  it('a 200 body carrying no `lines` key does not abort the caller without jq', () => {
    expect(reachesNextStatement('{"ok":true,"sessionId":"s"}', HIDE_JQ)).toBe(true);
  });

  it('a 200 body whose empty `lines` array misses the fast path does not abort it either', () => {
    // `"lines": []` with a space: the literal `"lines":[]` shortcut above the
    // decoder does not match it, so the sed fallback runs and yields nothing.
    expect(reachesNextStatement('{"ok":true,"lines": []}', HIDE_JQ)).toBe(true);
  });

  it('control: with jq present the same bodies already reached it', () => {
    expect(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status).toBe(0);
    expect(reachesNextStatement('{"ok":true,"sessionId":"s"}', '')).toBe(true);
    expect(reachesNextStatement('{"ok":true,"lines": []}', '')).toBe(true);
  });

  it('a 200 body that is not JSON at all does not abort the caller WITH jq either', () => {
    // jq exits 5 on it, and that pipeline is the last statement of its branch.
    expect(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status).toBe(0);
    expect(reachesNextStatement('not json at all', '')).toBe(true);
  });

  it('… and does not abort it without jq', () => {
    expect(reachesNextStatement('not json at all', HIDE_JQ)).toBe(true);
  });

  it('control: a body that DOES carry lines still delivers them, jq or not', () => {
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n200' '{"lines":["a notice"]}'\n`, {
      mode: 0o755,
    });
    for (const prelude of [HIDE_JQ, '']) {
      const out = spawnSync(
        'bash',
        [
          '-c',
          `source '${apiSh}'\n${prelude}\nLINES="$(rembric_turn_report /api/demo/sessions/s/turn '{}')"\nprintf '%s|%s' "$LINES" "${AFTER}"`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            REMBRIC_SERVER_URL: 'http://127.0.0.1:1',
            REMBRIC_API_TOKEN: 'tok',
          },
        },
      );
      expect(out.stdout).toBe(`a notice|${AFTER}`);
    }
  });
});

describe('the JSON string decoder is one implementation, and it agrees with jq', () => {
  function withoutJq(fn: string, input: string): string {
    return execFileSync(
      'bash',
      ['-c', `source '${apiSh}'\n${HIDE_JQ}\n${fn} '${input.replace(/'/g, `'\\''`)}'`],
      { encoding: 'utf8' },
    );
  }

  function viaJq(input: string, filter: string): string {
    return execFileSync(
      'bash',
      ['-c', `printf '%s' '${input.replace(/'/g, `'\\''`)}' | jq -j '${filter}'`],
      {
        encoding: 'utf8',
      },
    );
  }

  // Each is a payload the sed-plus-substitution fallbacks got wrong, plus the
  // ordinary shapes that must not regress.
  const bodies = [
    'plain text',
    'say "hi"\nthen stop',
    'back\\slash',
    'a\\nb',
    'tab\there',
    '',
    'multi\nline\nbody',
    'cr\rlf',
    'slash / solidus',
  ];

  for (const body of bodies) {
    const label = JSON.stringify(body);

    it(`prompt ${label} decodes exactly as jq does`, () => {
      const input = JSON.stringify({ prompt: body });
      expect(withoutJq('rembric_prompt_from_stdin_json', input)).toBe(
        body === '' ? '' : viaJq(input, '.prompt'),
      );
    });

    it(`compaction_summary ${label} decodes exactly as jq does`, () => {
      const input = JSON.stringify({ compaction_summary: body });
      expect(withoutJq('rembric_compaction_summary_from_stdin_json', input)).toBe(
        body === '' ? '' : viaJq(input, '.compaction_summary'),
      );
    });
  }

  it('the camelCase spelling still resolves when the snake_case key is absent', () => {
    const input = JSON.stringify({ compactionSummary: 'from codex' });
    expect(withoutJq('rembric_compaction_summary_from_stdin_json', input)).toBe('from codex');
  });

  it('a literal backslash-n survives as two characters, not as a newline', () => {
    // The ordering defect: `${s//\\n/…}` ran BEFORE `${s//\\\\/…}`, so the
    // `n` of an escaped backslash was consumed as a newline escape.
    expect(
      withoutJq('rembric_compaction_summary_from_stdin_json', '{"compaction_summary":"a\\\\nb"}'),
    ).toBe('a\\nb');
  });

  it('`\\uXXXX` is the ONE escape the fallback leaves verbatim, backslash included', () => {
    // Decoding it needs printf's `\uHHHH`, which is bash 4.2+ and macOS ships
    // 3.2 — so this is a documented divergence, and the backslash is kept so
    // the text stays recoverable. jq is the recommended path, and here is
    // what it would have produced instead.
    const input = '{"prompt":"caf\\u00e9"}';
    expect(withoutJq('rembric_prompt_from_stdin_json', input)).toBe('caf\\u00e9');
    expect(viaJq(input, '.prompt')).toBe('café');
  });

  it('there is exactly one escape-decoding table in the file', () => {
    const src = readFileSync(apiSh, 'utf8');
    // One mapping of the JSON `\n` escape to a real newline — the marker of the
    // single table every extractor routes through.
    expect(src.split('${s//\\\\n/').length - 1).toBe(1);
  });

  it('an invalid escape still loses its backslash, the way the scan did', () => {
    // Unreachable from a real host — jq refuses the payload outright and every
    // client serialises with a real JSON encoder — but it is the one shape
    // where the substitution chain could have silently changed the answer.
    expect(withoutJq('rembric_prompt_from_stdin_json', '{"prompt":"a\\qb"}')).toBe('aqb');
  });
});

describe('the no-jq prompt path stays off the quadratic curve', () => {
  // Both bounds are deliberately loose: they are complexity guards, not latency
  // SLAs. `UserPromptSubmit` is synchronous, its 60s budget is shared by
  // prompt-search.sh and prompt-nudge.sh (which parse the same prompt twice),
  // and the prompt itself is unbounded user input.
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rbr-perf-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /**
   * Reads the payload from a FILE: Linux caps a single exec argument at 128 KB,
   * so embedding a megabyte of prompt in the `bash -c` script would E2BIG.
   */
  function decodeWithoutJq(payload: string): { out: string; ms: number } {
    const file = join(tmp, 'payload.json');
    writeFileSync(file, payload);
    const script = [
      `source '${apiSh}'`,
      HIDE_JQ,
      `INPUT="$(cat '${file}')"`,
      `rembric_prompt_from_stdin_json "$INPUT"`,
    ].join('\n');
    const started = Date.now();
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return { out, ms: Date.now() - started };
  }

  it('decodes a 100 KB escape-heavy prompt without rescanning per escape', () => {
    // The escape-by-escape scan this replaced was O(n·k): 37ms at 5 KB, 491ms at
    // 20 KB, 3.1s at 50 KB and 11.6s at 100 KB on the reference host (0.3s after).
    const body = 'Refactor the "session router" and C:\\Users\\dev\\repo.\n'.repeat(2000);
    const payload = JSON.stringify({ session_id: 's', prompt: body });
    expect(payload.length).toBeGreaterThan(100_000);
    const { out, ms } = decodeWithoutJq(payload);
    // Control: it really decoded the whole prompt, so a fast run cannot be a run
    // that did nothing.
    expect(out).toBe(body);
    expect(ms).toBeLessThan(5_000);
  });

  it('finds the closing quote of a 1 MB prompt without retrying every split point', () => {
    // Escape-free on purpose: the decoder returns immediately, so what is left
    // is the search for the value's end. `${x%%"*}` measured 17.8s here against
    // 0.2s for `${x/"*/}`.
    const body = 'the quick brown fox jumps over the lazy dog and keeps going '.repeat(16_667);
    expect(body).not.toMatch(/["\\\n\r\t]/);
    const { out, ms } = decodeWithoutJq(JSON.stringify({ session_id: 's', prompt: body }));
    expect(out).toBe(body);
    expect(ms).toBeLessThan(5_000);
  });
});

describe('the no-jq boolean fallbacks do not depend on GNU sed', () => {
  // `\(true\|false\)` is a GNU extension: under a POSIX sed the alternation
  // matches a LITERAL `|`, so both fields came back EMPTY — the session-opening
  // nudge never fired, and stop-report.sh's recursion guard never cut.
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'rbr-posixsed-'));
    writePosixSedShim(bin);
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  /** Runs one _api.sh function with the POSIX sed shim first on PATH. */
  function underPosixSed(script: string, extraEnv: Record<string, string> = {}): string {
    return spawnSync('bash', ['-c', `source '${apiSh}'\n${HIDE_JQ}\n${script}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...extraEnv },
    }).stdout;
  }

  function ensureUnderPosixSed(responseBody: string): string {
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n200' '${responseBody}'\n`, {
      mode: 0o755,
    });
    return underPosixSed(`rembric_session_ensure /api/demo/sessions '{}'`, {
      REMBRIC_SERVER_URL: 'http://127.0.0.1:1',
      REMBRIC_API_TOKEN: 'tok',
    });
  }

  it.skipIf(!posixSedAvailable)(
    'control: the shim really forces POSIX BREs, and still substitutes',
    () => {
      const posix = (expr: string) =>
        spawnSync(join(bin, 'sed'), ['-n', expr], {
          input: '{"created":true}',
          encoding: 'utf8',
        }).stdout;
      // The expression this change removed: no capture, because `\|` is literal.
      expect(posix('s/.*"created"[[:space:]]*:[[:space:]]*\\(true\\|false\\).*/\\1/p')).toBe('');
      // …while an alternation-free BRE substitutes normally, so the empty result
      // above is the extension, not a broken shim.
      expect(posix('s/.*"created"[[:space:]]*:[[:space:]]*\\(true\\).*/\\1/p')).toBe('true');
    },
  );

  it.skipIf(!posixSedAvailable)('rembric_session_ensure reads `created` under a POSIX sed', () => {
    expect(ensureUnderPosixSed('{"ok":true,"created":true}')).toBe('true');
    expect(ensureUnderPosixSed('{"ok":true,"created":false}')).toBe('false');
  });

  it.skipIf(!posixSedAvailable)('… and still reports nothing when the field is absent', () => {
    expect(ensureUnderPosixSed('{"ok":true}')).toBe('');
  });

  it.skipIf(!posixSedAvailable)('stop_hook_active reads true/false under a POSIX sed', () => {
    const read = (input: string) =>
      underPosixSed(`rembric_stop_hook_active_from_stdin_json '${input}'`);
    expect(read('{"stop_hook_active":true}')).toBe('true');
    expect(read('{"stop_hook_active":false}')).toBe('false');
    expect(read('{"session_id":"s"}')).toBe('');
  });

  it.skipIf(!posixSedAvailable)(
    "stop-report.sh's recursion guard still cuts under a POSIX sed",
    () => {
      // The boundary that matters: an empty `stop_hook_active` reads as "not a
      // continuation", so the hook walked on to the turn report on every one of
      // Claude Code's continuations.
      const work = mkdtempSync(join(tmpdir(), 'rbr-stopguard-'));
      try {
        writeFileSync(join(work, '.rembric'), 'PROJECT_SLUG=demo\n');
        writeFileSync(
          join(bin, 'curl'),
          `#!/bin/sh\n: >'${join(work, 'posted')}'\nprintf '{"ok":true,"lines":[]}\\n200'\n`,
          { mode: 0o755 },
        );
        const run = (stopHookActive: boolean) => {
          rmSync(join(work, 'posted'), { force: true });
          spawnSync(
            'bash',
            ['-c', `${HIDE_JQ}\nexec '${join(scripts, 'stop-report.sh')}' codex-cli`],
            {
              input: JSON.stringify({
                session_id: 's1',
                cwd: work,
                stop_hook_active: stopHookActive,
              }),
              encoding: 'utf8',
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                REMBRIC_SERVER_URL: 'http://127.0.0.1:1',
                REMBRIC_API_TOKEN: 'tok',
              },
            },
          );
          return existsSync(join(work, 'posted'));
        };
        expect(run(true)).toBe(false);
        // Control: the same wiring DOES post when the turn is not a continuation,
        // so the `false` above cannot be a hook that never ran.
        expect(run(false)).toBe(true);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

describe('rembric_prompt_from_stdin_json — a non-object body must not abort the caller', () => {
  // `jq` exits 5 on any body that is not a JSON object, and this pipeline is the
  // LAST statement of its branch, so the `trap 'exit 0' ERR` at the top of
  // _api.sh kills the CALLER at its `PROMPT="$(…)"` assignment.
  const AFTER = 'REACHED-NEXT-STATEMENT';

  function reachesNextStatement(input: string, prelude: string): boolean {
    const script = [
      `source '${apiSh}'`,
      prelude,
      `PROMPT="$(rembric_prompt_from_stdin_json '${input.replace(/'/g, `'\\''`)}')"`,
      `printf '%s' "${AFTER}"`,
    ].join('\n');
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.includes(AFTER);
  }

  it('a JSON array body does not abort the caller with jq present', () => {
    expect(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status).toBe(0);
    expect(reachesNextStatement('["x",{"session_id":"s"}]', '')).toBe(true);
  });

  it('neither does a body that is not JSON at all', () => {
    expect(reachesNextStatement('not json at all', '')).toBe(true);
  });

  it('control: an ordinary object body already reached it, jq or not', () => {
    for (const prelude of ['', HIDE_JQ]) {
      expect(reachesNextStatement('{"prompt":"hello"}', prelude)).toBe(true);
    }
  });

  it('prompt-search.sh still emits its fail-open nudge on an unparseable body', () => {
    // The real boundary: the hook dies at its `PROMPT=` assignment, so the
    // keyword nudge its `else` branch owes an unparseable stdin never prints.
    const run = (input: string) =>
      spawnSync(join(scripts, 'prompt-search.sh'), [], { input, encoding: 'utf8' })
        .stdout.split('\n')
        .filter(Boolean);
    const lines = run(`["x",{"session_id":"pf-${process.pid}-a"}]`);
    expect(lines.some((l) => l.includes('memory.search'))).toBe(true);
    // Control: a well-formed body carrying no keyword stays quiet, so the line
    // above is the fail-open branch and not something this hook always prints.
    const quiet = run(
      JSON.stringify({ session_id: `pf-${process.pid}-b`, prompt: 'just do the thing' }),
    );
    expect(quiet.some((l) => l.includes('memory.search'))).toBe(false);
  });
});
