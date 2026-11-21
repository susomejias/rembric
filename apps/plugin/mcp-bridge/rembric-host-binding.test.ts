import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ancestorChain,
  HOST_BINDING_FILE_MODE,
  HOST_BINDING_KEYS,
  HOST_SESSION_HEADER,
  HOST_SESSIONS_DIR,
  HOST_SESSIONS_DIR_MODE,
  hostBindingPath,
  hostSessionsDir,
  lookupHostSession,
  MAX_ANCESTORS,
  processStartToken,
  publishHostBinding,
  removeHostBinding,
  SESSION_ID_RE,
  START_LOCALE,
  startTokenArgs,
} from './rembric-host-binding.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const layout = JSON.parse(
  readFileSync(join(here, '..', 'test', 'host-binding-layout.json'), 'utf8'),
) as {
  header: string;
  sessionIdPattern: string;
  dir: string[];
  dirMode: string;
  file: string;
  fileMode: string;
  keys: string[];
  startCommand: string[];
  startLocale: string;
  maxAncestors: number;
};

const SESSION_A = 'session-aaaaaaaa';
const SESSION_B = 'session-bbbbbbbb';

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rembric-host-binding-'));
  homes.push(home);
  return home;
}

function writeBinding(home: string, pid: number, body: unknown): void {
  const dir = hostSessionsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

function fakePs(table: Record<number, { ppid: number; start: string | null }>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const pid = Number(args[args.length - 1]);
    const row = table[pid];
    if (!row) return null;
    if (args[1] === 'lstart=') return row.start === null ? '' : row.start;
    if (args[1] === 'ppid=') return `  ${row.ppid}\n`;
    return null;
  };
  return { run, calls };
}

describe('the module agrees with the shared host-binding layout fixture', () => {
  it('pins the header, id pattern, directory, modes, keys, start command, locale and limits', () => {
    expect(HOST_SESSION_HEADER).toBe(layout.header);
    expect(SESSION_ID_RE.source).toBe(layout.sessionIdPattern);
    expect(HOST_SESSIONS_DIR).toEqual(layout.dir);
    expect(HOST_SESSIONS_DIR_MODE).toBe(Number.parseInt(layout.dirMode, 8));
    expect(HOST_BINDING_FILE_MODE).toBe(Number.parseInt(layout.fileMode, 8));
    expect(HOST_BINDING_KEYS).toEqual(layout.keys);
    expect(['ps', ...startTokenArgs('{pid}')]).toEqual(layout.startCommand);
    expect(START_LOCALE).toBe(layout.startLocale);
    expect(MAX_ANCESTORS).toBe(layout.maxAncestors);
    expect(hostBindingPath(4242, '/home/u')).toBe(
      join('/home/u', ...layout.dir, layout.file.replace('{pid}', '4242')),
    );
  });
});

describe('processStartToken', () => {
  it('collapses whitespace runs and trims the ps output', () => {
    const { run } = fakePs({ 10: { ppid: 1, start: '  Sat Nov  7 09:05:03   2026\n' } });
    expect(processStartToken(10, { run })).toBe('Sat Nov 7 09:05:03 2026');
  });

  it('is null when ps fails or prints nothing', () => {
    const { run } = fakePs({ 10: { ppid: 1, start: null } });
    expect(processStartToken(10, { run })).toBeNull();
    expect(processStartToken(11, { run })).toBeNull();
  });

  it('reads the real start time of this process with LC_ALL=C', () => {
    const token = processStartToken(process.pid);
    expect(token).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(processStartToken(process.pid)).toBe(token);
  });
});

describe('ancestorChain', () => {
  it('walks from the parent upwards, recording each start token, and stops at PID 1', () => {
    const { run } = fakePs({
      30: { ppid: 20, start: 'start-30' },
      20: { ppid: 10, start: 'start-20' },
      10: { ppid: 1, start: 'start-10' },
      1: { ppid: 0, start: 'start-1' },
    });
    expect(ancestorChain({ ppid: 30, run, platform: 'linux' })).toEqual([
      { pid: 30, start: 'start-30' },
      { pid: 20, start: 'start-20' },
      { pid: 10, start: 'start-10' },
    ]);
  });

  it('records at most eight ancestors', () => {
    const table: Record<number, { ppid: number; start: string }> = {};
    for (let pid = 100; pid > 2; pid -= 1) table[pid] = { ppid: pid - 1, start: `start-${pid}` };
    const chain = ancestorChain({ ppid: 100, run: fakePs(table).run, platform: 'linux' });
    expect(chain.map((entry: { pid: number }) => entry.pid)).toEqual([
      100, 99, 98, 97, 96, 95, 94, 93,
    ]);
  });

  it('skips an ancestor whose start token is unavailable', () => {
    const { run } = fakePs({
      30: { ppid: 20, start: null },
      20: { ppid: 1, start: 'start-20' },
    });
    expect(ancestorChain({ ppid: 30, run, platform: 'linux' })).toEqual([
      { pid: 20, start: 'start-20' },
    ]);
  });

  it('is empty on win32 without probing anything', () => {
    const { run, calls } = fakePs({ 30: { ppid: 1, start: 'start-30' } });
    expect(ancestorChain({ ppid: 30, run, platform: 'win32' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('starts at the real parent of this process', () => {
    const chain = ancestorChain();
    expect(chain[0]).toEqual({ pid: process.ppid, start: processStartToken(process.ppid) });
  });
});

describe('publishHostBinding', () => {
  it('writes exactly {pid,start,sessionId} with mode 0600 in a 0700 directory, leaving no temporary file', () => {
    const home = scratchHome();
    expect(publishHostBinding({ pid: 4242, sessionId: SESSION_A, start: 'start-4242', home })).toBe(
      true,
    );
    const dir = hostSessionsDir(home);
    expect(readdirSync(dir)).toEqual(['4242.json']);
    const raw = readFileSync(join(dir, '4242.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(layout.keys);
    expect(parsed).toEqual({ pid: 4242, start: 'start-4242', sessionId: SESSION_A });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, '4242.json')).mode & 0o777).toBe(0o600);
  });

  it('replaces a previous binding for the same process', () => {
    const home = scratchHome();
    publishHostBinding({ pid: 4242, sessionId: SESSION_A, start: 'start-4242', home });
    publishHostBinding({ pid: 4242, sessionId: SESSION_B, start: 'start-4242', home });
    expect(lookupHostSession([{ pid: 4242, start: 'start-4242' }], { home })).toBe(SESSION_B);
    expect(readdirSync(hostSessionsDir(home))).toEqual(['4242.json']);
  });

  it('tightens an existing directory to 0700', () => {
    const home = scratchHome();
    mkdirSync(hostSessionsDir(home), { recursive: true, mode: 0o755 });
    chmodSync(hostSessionsDir(home), 0o755);
    publishHostBinding({ pid: 4242, sessionId: SESSION_A, start: 'start-4242', home });
    expect(statSync(hostSessionsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('publishes the probed start token when none is given', () => {
    const home = scratchHome();
    const { run } = fakePs({ 4242: { ppid: 1, start: 'Mon  Nov 16 10:00:00 2026' } });
    expect(publishHostBinding({ pid: 4242, sessionId: SESSION_A, home, run })).toBe(true);
    expect(lookupHostSession([{ pid: 4242, start: 'Mon Nov 16 10:00:00 2026' }], { home })).toBe(
      SESSION_A,
    );
  });

  it('publishes nothing when the start token is unavailable', () => {
    const home = scratchHome();
    const { run } = fakePs({});
    expect(publishHostBinding({ pid: 4242, sessionId: SESSION_A, home, run })).toBe(false);
    expect(() => readdirSync(hostSessionsDir(home))).toThrow();
  });

  it('refuses a session id outside the header pattern', () => {
    const home = scratchHome();
    for (const sessionId of ['short', 'has space in it', 'x'.repeat(129), '']) {
      expect(publishHostBinding({ pid: 4242, sessionId, start: 'start-4242', home })).toBe(false);
    }
    expect(() => readdirSync(hostSessionsDir(home))).toThrow();
  });

  it('is a no-op on win32', () => {
    const home = scratchHome();
    expect(
      publishHostBinding({
        pid: 4242,
        sessionId: SESSION_A,
        start: 'start-4242',
        home,
        platform: 'win32',
      }),
    ).toBe(false);
    expect(() => readdirSync(hostSessionsDir(home))).toThrow();
  });

  it('never throws when the directory cannot be created', () => {
    const home = scratchHome();
    writeFileSync(join(home, '.cache'), 'not a directory');
    expect(publishHostBinding({ pid: 4242, sessionId: SESSION_A, start: 's', home })).toBe(false);
  });
});

describe('removeHostBinding', () => {
  it('removes the file only while it still names the session being closed', () => {
    const home = scratchHome();
    publishHostBinding({ pid: 4242, sessionId: SESSION_B, start: 'start-4242', home });
    expect(removeHostBinding({ pid: 4242, sessionId: SESSION_A, home })).toBe(false);
    expect(readdirSync(hostSessionsDir(home))).toEqual(['4242.json']);
    expect(removeHostBinding({ pid: 4242, sessionId: SESSION_B, home })).toBe(true);
    expect(readdirSync(hostSessionsDir(home))).toEqual([]);
  });

  it('is quiet when nothing is published', () => {
    expect(removeHostBinding({ pid: 4242, sessionId: SESSION_A, home: scratchHome() })).toBe(false);
  });
});

describe('lookupHostSession', () => {
  const chain = [
    { pid: 300, start: 'start-300' },
    { pid: 200, start: 'start-200' },
    { pid: 100, start: 'start-100' },
  ];

  it('returns the nearest ancestor whose pid and start match', () => {
    const home = scratchHome();
    writeBinding(home, 200, { pid: 200, start: 'start-200', sessionId: SESSION_A });
    writeBinding(home, 100, { pid: 100, start: 'start-100', sessionId: SESSION_B });
    expect(lookupHostSession(chain, { home })).toBe(SESSION_A);
  });

  it('rejects a binding whose start differs (a reused PID) and keeps walking', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: 'another-process', sessionId: SESSION_A });
    writeBinding(home, 100, { pid: 100, start: 'start-100', sessionId: SESSION_B });
    expect(lookupHostSession(chain, { home })).toBe(SESSION_B);
  });

  it('rejects a binding whose pid field differs from its file name', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 301, start: 'start-300', sessionId: SESSION_A });
    writeBinding(home, 200, { pid: '200', start: 'start-200', sessionId: SESSION_A });
    expect(lookupHostSession(chain, { home })).toBeNull();
  });

  it('rejects a malformed session id', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId: 'bad id!' });
    writeBinding(home, 200, { pid: 200, start: 'start-200', sessionId: 'short' });
    writeBinding(home, 100, { pid: 100, start: 'start-100', sessionId: 12345678 });
    expect(lookupHostSession(chain, { home })).toBeNull();
  });

  it('ignores garbage and unreadable files', () => {
    const home = scratchHome();
    writeBinding(home, 300, '{not json');
    writeBinding(home, 200, { pid: 200, start: 'start-200', sessionId: SESSION_A });
    chmodSync(hostBindingPath(200, home), 0o000);
    writeBinding(home, 100, 'null');
    expect(lookupHostSession(chain, { home })).toBeNull();
  });

  it('accepts extra keys', () => {
    const home = scratchHome();
    writeBinding(home, 100, { pid: 100, start: 'start-100', sessionId: SESSION_B, extra: 1 });
    expect(lookupHostSession(chain, { home })).toBe(SESSION_B);
  });

  it('finds nothing with no directory, an empty chain, or on win32', () => {
    const home = scratchHome();
    expect(lookupHostSession(chain, { home })).toBeNull();
    writeBinding(home, 100, { pid: 100, start: 'start-100', sessionId: SESSION_B });
    expect(lookupHostSession([], { home })).toBeNull();
    expect(lookupHostSession(chain, { home, platform: 'win32' })).toBeNull();
  });
});
