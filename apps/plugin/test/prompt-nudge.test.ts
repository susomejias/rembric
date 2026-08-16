import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  sessionOpening: string;
  resumedRead: string;
  sessionIdTemplate: string;
};

function sessionIdLine(sessionId: string): string {
  return fixtures.sessionIdTemplate.replace('{{SESSION_ID}}', sessionId);
}

let counterDir: string;

function runPromptNudge(stdin: string): string {
  return execFileSync('bash', [promptNudgeSh], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
}

function markCreated(sessionId: string, value: '1' | '0'): void {
  const dir = join(counterDir, 'rembric-created');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), value);
}

function markResumed(sessionId: string): void {
  const dir = join(counterDir, 'rembric-resumed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), '1');
}

function writePending(sessionId: string, text: string): void {
  const dir = join(counterDir, 'rembric-pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), text);
}

describe('prompt-nudge.sh (report-print contract, no cadence)', () => {
  beforeEach(() => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-promptnudge-'));
  });
  afterEach(() => rmSync(counterDir, { recursive: true, force: true }));

  it('counts nothing: no modulo, no cadence constant, no turn-counter call', () => {
    const src = readFileSync(promptNudgeSh, 'utf8');
    expect(src).not.toMatch(/%\s*\d/);
    expect(src).not.toContain('rembric_turn_count');
    expect(src).not.toMatch(/NUDGE_EVERY/);
  });

  it('emits zero bytes on a turn with nothing cached, no opening due, no resume', () => {
    const out = runPromptNudge(JSON.stringify({ session_id: 's-quiet' }));
    expect(out).toBe('');
  });

  it('emits the sessionId line + the session opening once, on a newly created session', () => {
    markCreated('s-new', '1');
    const first = runPromptNudge(JSON.stringify({ session_id: 's-new' }));
    expect(first.trim()).toBe(`${sessionIdLine('s-new')}\n${fixtures.sessionOpening}`);

    const second = runPromptNudge(JSON.stringify({ session_id: 's-new' }));
    expect(second).toBe('');
  });

  it('does not emit the opening for a session whose ensure reported created:false', () => {
    markCreated('s-existing', '0');
    const out = runPromptNudge(JSON.stringify({ session_id: 's-existing' }));
    expect(out).not.toContain(fixtures.sessionOpening);
  });

  it('emits the resumed-read line once, without the sessionId line, for a resumed session', () => {
    markResumed('s-resumed');
    const first = runPromptNudge(JSON.stringify({ session_id: 's-resumed' }));
    expect(first.trim()).toBe(fixtures.resumedRead);

    const second = runPromptNudge(JSON.stringify({ session_id: 's-resumed' }));
    expect(second).toBe('');
  });

  it('prints a cached server notice verbatim, preceded by the sessionId line, then clears it', () => {
    writePending('s-notice', 'rembric: a server-composed notice line');
    const first = runPromptNudge(JSON.stringify({ session_id: 's-notice' }));
    expect(first.trim()).toBe(
      `${sessionIdLine('s-notice')}\nrembric: a server-composed notice line`,
    );

    const second = runPromptNudge(JSON.stringify({ session_id: 's-notice' }));
    expect(second).toBe('');
  });

  it('omits the sessionId line when the session id is unknown', () => {
    writePending('unused', 'irrelevant');
    const out = runPromptNudge('{}');
    expect(out).toBe('');
  });

  it('tracks separate sessions independently', () => {
    markCreated('s-a', '1');
    runPromptNudge(JSON.stringify({ session_id: 's-a' }));
    const outB = runPromptNudge(JSON.stringify({ session_id: 's-b' }));
    expect(outB).toBe('');
  });

  it('records the first user prompt, redacted and capped at 100 chars, for stop-report.sh', () => {
    const long = `first prompt ${'x'.repeat(200)} <private>secret</private>`;
    runPromptNudge(JSON.stringify({ session_id: 's-title', prompt: long }));
    const stored = readFileSync(join(counterDir, 'rembric-first-prompt', 's-title'), 'utf8');
    expect(stored.length).toBeLessThanOrEqual(100);
    expect(stored).not.toContain('secret');
  });

  it('does not overwrite the recorded first prompt on a later turn', () => {
    runPromptNudge(JSON.stringify({ session_id: 's-first-only', prompt: 'first one' }));
    runPromptNudge(JSON.stringify({ session_id: 's-first-only', prompt: 'second one' }));
    const stored = readFileSync(join(counterDir, 'rembric-first-prompt', 's-first-only'), 'utf8');
    expect(stored).toBe('first one');
  });

  it('collapses newlines and tabs — the recorded title is one line', () => {
    runPromptNudge(
      JSON.stringify({ session_id: 's-multiline', prompt: 'line one\nline two\ttabbed' }),
    );
    const stored = readFileSync(join(counterDir, 'rembric-first-prompt', 's-multiline'), 'utf8');
    expect(stored).toBe('line one line two tabbed');
  });

  it('does not re-record a first prompt once stop-report.sh has consumed it', () => {
    runPromptNudge(JSON.stringify({ session_id: 's-consumed', prompt: 'the real first prompt' }));
    // Consume it the way stop-report.sh does.
    const taken = execFileSync(
      'bash',
      [
        '-c',
        `source '${join(here, '..', 'scripts', '_api.sh')}'; rembric_first_prompt_take $1`,
        'sh',
        's-consumed',
      ],
      { encoding: 'utf8', env: { ...process.env, TMPDIR: counterDir } },
    );
    expect(taken).toBe('the real first prompt');

    runPromptNudge(JSON.stringify({ session_id: 's-consumed', prompt: 'a later prompt' }));
    expect(existsSync(join(counterDir, 'rembric-first-prompt', 's-consumed'))).toBe(false);
  });

  it('fails safe on unreadable or empty stdin: exits 0 and emits nothing', () => {
    expect(runPromptNudge('').trim()).toBe('');
    expect(runPromptNudge('not json').trim()).toBe('');
  });
});
