import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  save: string;
  summary: string;
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

function runPromptNudgeAsync(stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'bash',
      [promptNudgeSh],
      { encoding: 'utf8', env: { ...process.env, TMPDIR: counterDir } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.end(stdin);
  });
}

describe('prompt-nudge.sh (unified per-turn save + summary nudge)', () => {
  beforeEach(() => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-promptnudge-'));
  });
  afterEach(() => rmSync(counterDir, { recursive: true, force: true }));

  it('emits the sessionId line + summary nudge on turn 1 (plain stdout, no JSON wrapper)', () => {
    const out = runPromptNudge(JSON.stringify({ session_id: 's-turn1' }));
    expect(out.trim()).toBe(`${sessionIdLine('s-turn1')}\n${fixtures.summary}`);
    expect(out).not.toContain('hookSpecificOutput');
  });

  it('stays silent on turns 2-4', () => {
    runPromptNudge(JSON.stringify({ session_id: 's-mid' })); // turn 1 (summary only)
    for (let i = 2; i <= 4; i++) {
      const out = runPromptNudge(JSON.stringify({ session_id: 's-mid' }));
      expect(out.trim()).toBe('');
    }
  });

  it('emits the sessionId line + save nudge on turn 5', () => {
    let last = '';
    for (let i = 1; i <= 5; i++) {
      last = runPromptNudge(JSON.stringify({ session_id: 's-five' }));
    }
    expect(last.trim()).toBe(`${sessionIdLine('s-five')}\n${fixtures.save}`);
  });

  it('emits the sessionId line + BOTH nudges on turn 10 (save first)', () => {
    let last = '';
    for (let i = 1; i <= 10; i++) {
      last = runPromptNudge(JSON.stringify({ session_id: 's-ten' }));
    }
    const lines = last.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual([sessionIdLine('s-ten'), fixtures.save, fixtures.summary]);
  });

  it('persists the counter per session across invocations', () => {
    runPromptNudge(JSON.stringify({ session_id: 's-persist' }));
    runPromptNudge(JSON.stringify({ session_id: 's-persist' }));
    runPromptNudge(JSON.stringify({ session_id: 's-persist' }));
    runPromptNudge(JSON.stringify({ session_id: 's-persist' }));
    const out = runPromptNudge(JSON.stringify({ session_id: 's-persist' }));
    expect(out.trim()).toBe(`${sessionIdLine('s-persist')}\n${fixtures.save}`);
  });

  it('tracks separate sessions independently', () => {
    for (let i = 1; i <= 5; i++) runPromptNudge(JSON.stringify({ session_id: 's-a' }));
    const outB = runPromptNudge(JSON.stringify({ session_id: 's-b' }));
    expect(outB.trim()).toBe(`${sessionIdLine('s-b')}\n${fixtures.summary}`);
  });

  it('falls back to a session key and exits 0 on empty/unparseable stdin', () => {
    expect(runPromptNudge('').trim()).toBe(fixtures.summary);
    expect(runPromptNudge('not json').trim()).toBe('');
  });

  it('does not lose increments under concurrent invocations for the same session', async () => {
    const n = 20;
    await Promise.all(
      Array.from({ length: n }, () =>
        runPromptNudgeAsync(JSON.stringify({ session_id: 's-concurrent' })),
      ),
    );
    const counterFile = join(counterDir, 'rembric-turnnudge', 's-concurrent');
    expect(readFileSync(counterFile, 'utf8').length).toBe(n);
  });
});
