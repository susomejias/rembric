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
  isLauncher,
  LAUNCHER_COMMANDS,
  lookupHostSession,
  MAX_ANCESTORS,
  NON_HOST_COMMANDS,
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
  nonHostCommands: string[];
  launcherCommands: string[];
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

type PsRow = { ppid: number; start: string | null; comm?: string; args?: string };

function fakePs(table: Record<number, PsRow>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const pid = Number(args[args.length - 1]);
    const row = table[pid];
    if (!row) return null;
    if (args[1] === 'lstart=') return row.start === null ? '' : row.start;
    if (args[1] === 'ppid=') return `  ${row.ppid}\n`;
    if (args[1] === 'comm=') return `${row.comm ?? 'host'}\n`;
    if (args[1] === 'args=') return `${row.args ?? row.comm ?? 'host'}   \n`;
    return null;
  };
  return { run, calls };
}

const NPM_EXEC = {
  comm: 'npm exec @rembric/mcp-bridge@0.44.2',
  args: 'npm exec @rembric/mcp-bridge@0.44.2',
};

function resolveSession(table: Record<number, PsRow>, ppid: number, home: string) {
  return lookupHostSession(ancestorChain({ ppid, run: fakePs(table).run, platform: 'linux' }), {
    home,
  });
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
    expect(NON_HOST_COMMANDS).toEqual(layout.nonHostCommands);
    expect(LAUNCHER_COMMANDS).toEqual(layout.launcherCommands);
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

  it('runs ps with LC_ALL=C whatever locale the caller exports', () => {
    const bin = mkdtempSync(join(tmpdir(), 'rembric-fake-ps-'));
    homes.push(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "LC_ALL=%s LANG=%s\\n" "$LC_ALL" "$LANG"\n');
    chmodSync(join(bin, 'ps'), 0o755);
    const saved = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANG = 'de_DE.UTF-8';
    try {
      expect(processStartToken(4242)).toBe('LC_ALL=C LANG=de_DE.UTF-8');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reads the real start time of this process with LC_ALL=C', () => {
    const token = processStartToken(process.pid);
    expect(token).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(processStartToken(process.pid)).toBe(token);
  });
});

describe('isLauncher', () => {
  it.each([
    ['sh', 'sh -c mcp-bridge'],
    ['/bin/bash', '/bin/bash -c mcp-bridge'],
    ['-zsh', '-zsh'],
    ['dash', 'dash'],
    ['ksh', 'ksh'],
    ['fish', 'fish'],
    ['/usr/bin/env', '/usr/bin/env node mcp-bridge'],
    ['npm', 'npm exec @rembric/mcp-bridge'],
    ['/opt/homebrew/bin/npx', '/opt/homebrew/bin/npx -y @rembric/mcp-bridge'],
  ])('treats the command %s as a launcher', (comm, args) => {
    expect(isLauncher({ comm, args })).toBe(true);
  });

  it.each([
    'npm exec @rembric/mcp-bridge@0.44.2',
    'npx -y @rembric/mcp-bridge@0.44.2',
    'npx',
    '/usr/local/bin/npm exec @rembric/mcp-bridge',
    '/opt/homebrew/bin/npx',
    'node /usr/local/lib/node_modules/npm/bin/npm-cli.js exec @rembric/mcp-bridge',
    '/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npx-cli.js -y @rembric/mcp-bridge',
  ])('treats the npm launcher command line %s as a launcher', (args) => {
    expect(isLauncher({ comm: 'node', args })).toBe(true);
  });

  it.each([
    ['claude', 'claude --chrome'],
    ['opencode', 'opencode'],
    ['node', 'node /usr/local/bin/codex'],
    ['python3.12', 'python3.12 /usr/local/bin/hermes'],
    ['npm-run-all', 'npm-run-all build'],
    ['node', 'node /x/npmish exec y'],
    ['node', 'node /x/npm-cli.jsx exec y'],
    ['', ''],
  ])('treats %s (%s) as a host', (comm, args) => {
    expect(isLauncher({ comm, args })).toBe(false);
  });
});

describe('ancestorChain', () => {
  it('walks past launchers to the nearest host, records only its start token, and stops there', () => {
    const { run, calls } = fakePs({
      40: { ppid: 30, start: 'start-40', ...NPM_EXEC },
      30: { ppid: 20, start: 'start-30', comm: 'sh', args: 'sh -c npx' },
      20: { ppid: 10, start: 'start-20', comm: 'claude', args: 'claude --chrome' },
      10: { ppid: 1, start: 'start-10', comm: 'zsh', args: '-zsh' },
    });
    expect(ancestorChain({ ppid: 40, run, platform: 'linux' })).toEqual([
      { pid: 40, launcher: true },
      { pid: 30, launcher: true },
      { pid: 20, start: 'start-20', launcher: false },
    ]);
    expect(calls.some((args) => args[args.length - 1] === '10')).toBe(false);
  });

  it('is just the parent when the parent is the host', () => {
    const { run } = fakePs({ 20: { ppid: 10, start: 'start-20', comm: 'claude' } });
    expect(ancestorChain({ ppid: 20, run, platform: 'linux' })).toEqual([
      { pid: 20, start: 'start-20', launcher: false },
    ]);
  });

  it('gives up after eight launchers without finding a host', () => {
    const table: Record<number, PsRow> = {};
    for (let pid = 100; pid > 2; pid -= 1) {
      table[pid] = { ppid: pid - 1, start: `start-${pid}`, comm: 'zsh' };
    }
    table[92] = { ppid: 91, start: 'start-92', comm: 'claude' };
    const chain = ancestorChain({ ppid: 100, run: fakePs(table).run, platform: 'linux' });
    expect(chain.map((entry: { pid: number }) => entry.pid)).toEqual([
      100, 99, 98, 97, 96, 95, 94, 93,
    ]);
    expect(chain.every((entry: { launcher: boolean }) => entry.launcher)).toBe(true);
  });

  it('stops before PID 1', () => {
    const { run, calls } = fakePs({
      30: { ppid: 1, start: 'start-30', comm: 'sh' },
      1: { ppid: 0, start: 'start-1', comm: 'launchd' },
    });
    expect(ancestorChain({ ppid: 30, run, platform: 'linux' })).toEqual([
      { pid: 30, launcher: true },
    ]);
    expect(calls.some((args) => args[args.length - 1] === '1')).toBe(false);
  });

  it('stops at a launcher that reports itself as its own parent', () => {
    const { run } = fakePs({ 30: { ppid: 30, start: 'start-30', comm: 'sh' } });
    expect(ancestorChain({ ppid: 30, run, platform: 'linux' })).toEqual([
      { pid: 30, launcher: true },
    ]);
  });

  it('records the host with a null start when its start token is unavailable', () => {
    const { run } = fakePs({
      30: { ppid: 20, start: null, comm: 'opencode' },
      20: { ppid: 1, start: 'start-20', comm: 'claude' },
    });
    expect(ancestorChain({ ppid: 30, run, platform: 'linux' })).toEqual([
      { pid: 30, start: null, launcher: false },
    ]);
  });

  it('is empty on win32 without probing anything', () => {
    const { run, calls } = fakePs({ 30: { ppid: 1, start: 'start-30' } });
    expect(ancestorChain({ ppid: 30, run, platform: 'win32' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('starts at the real parent of this process and ends at its host', () => {
    const chain = ancestorChain();
    expect(chain[0].pid).toBe(process.ppid);
    const host = chain[chain.length - 1];
    expect(host.launcher).toBe(false);
    expect(host.start).toBe(processStartToken(host.pid));
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
  const host = { pid: 300, start: 'start-300', launcher: false };

  it('reads the binding of the host only, never an outer process', () => {
    const home = scratchHome();
    writeBinding(home, 200, { pid: 200, start: 'start-200', sessionId: SESSION_A });
    const chain = [
      { pid: 400, launcher: true },
      host,
      { pid: 200, start: 'start-200', launcher: false },
    ];
    expect(lookupHostSession(chain, { home })).toBeNull();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId: SESSION_B });
    expect(lookupHostSession(chain, { home })).toBe(SESSION_B);
  });

  it('treats a chain entry without a launcher flag as the host', () => {
    const home = scratchHome();
    writeBinding(home, 200, { pid: 200, start: 'start-200', sessionId: SESSION_A });
    const chain = [
      { pid: 300, start: 'start-300' },
      { pid: 200, start: 'start-200' },
    ];
    expect(lookupHostSession(chain, { home })).toBeNull();
  });

  it('finds nothing when the chain holds launchers only', () => {
    const home = scratchHome();
    writeBinding(home, 400, { pid: 400, start: 'start-400', sessionId: SESSION_A });
    expect(lookupHostSession([{ pid: 400, start: 'start-400', launcher: true }], { home })).toBe(
      null,
    );
  });

  it('rejects a binding whose start differs (a reused PID)', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: 'another-process', sessionId: SESSION_A });
    expect(lookupHostSession([host], { home })).toBeNull();
  });

  it('never matches a host whose start token is unavailable', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: null, sessionId: SESSION_A });
    expect(lookupHostSession([{ pid: 300, start: null, launcher: false }], { home })).toBeNull();
  });

  it('rejects a binding whose pid field differs from its file name', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 301, start: 'start-300', sessionId: SESSION_A });
    expect(lookupHostSession([host], { home })).toBeNull();
    writeBinding(home, 300, { pid: '300', start: 'start-300', sessionId: SESSION_A });
    expect(lookupHostSession([host], { home })).toBeNull();
  });

  it.each(['bad id!', 'short', 12345678])('rejects the malformed session id %s', (sessionId) => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId });
    expect(lookupHostSession([host], { home })).toBeNull();
  });

  it('ignores garbage and unreadable files', () => {
    const home = scratchHome();
    writeBinding(home, 300, '{not json');
    expect(lookupHostSession([host], { home })).toBeNull();
    writeBinding(home, 300, 'null');
    expect(lookupHostSession([host], { home })).toBeNull();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId: SESSION_A });
    chmodSync(hostBindingPath(300, home), 0o000);
    expect(lookupHostSession([host], { home })).toBeNull();
  });

  it('accepts extra keys', () => {
    const home = scratchHome();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId: SESSION_B, extra: 1 });
    expect(lookupHostSession([host], { home })).toBe(SESSION_B);
  });

  it('finds nothing with no directory, an empty chain, or on win32', () => {
    const home = scratchHome();
    expect(lookupHostSession([host], { home })).toBeNull();
    writeBinding(home, 300, { pid: 300, start: 'start-300', sessionId: SESSION_B });
    expect(lookupHostSession([], { home })).toBeNull();
    expect(lookupHostSession([host], { home, platform: 'win32' })).toBeNull();
  });
});

describe('the bridge consults only its own host', () => {
  it('sends nothing for a nested host without a binding, even when an outer host has one', () => {
    const home = scratchHome();
    writeBinding(home, 10, { pid: 10, start: 'start-10', sessionId: SESSION_A });
    const table = {
      40: { ppid: 30, start: 'start-40', ...NPM_EXEC },
      30: { ppid: 20, start: 'start-30', comm: 'opencode', args: 'opencode' },
      20: { ppid: 10, start: 'start-20', comm: 'zsh', args: '-zsh' },
      10: { ppid: 1, start: 'start-10', comm: 'claude', args: 'claude --chrome' },
    };
    expect(resolveSession(table, 40, home)).toBeNull();
  });

  it('declares the host session through the npm exec launcher', () => {
    const home = scratchHome();
    writeBinding(home, 10, { pid: 10, start: 'start-10', sessionId: SESSION_A });
    const table = {
      40: { ppid: 10, start: 'start-40', ...NPM_EXEC },
      10: { ppid: 1, start: 'start-10', comm: 'claude', args: 'claude --chrome' },
    };
    expect(resolveSession(table, 40, home)).toBe(SESSION_A);
  });

  it('declares the host session when the host is the direct parent', () => {
    const home = scratchHome();
    writeBinding(home, 10, { pid: 10, start: 'start-10', sessionId: SESSION_A });
    const table = { 10: { ppid: 1, start: 'start-10', comm: 'claude', args: 'claude' } };
    expect(resolveSession(table, 10, home)).toBe(SESSION_A);
  });

  it('declares the host session through a node npm-cli.js exec launcher', () => {
    const home = scratchHome();
    writeBinding(home, 10, { pid: 10, start: 'start-10', sessionId: SESSION_B });
    const table = {
      40: {
        ppid: 10,
        start: 'start-40',
        comm: 'node',
        args: 'node /x/npm-cli.js exec @rembric/mcp-bridge',
      },
      10: { ppid: 1, start: 'start-10', comm: 'python3', args: 'python3 /usr/local/bin/hermes' },
    };
    expect(resolveSession(table, 40, home)).toBe(SESSION_B);
  });

  it('sends nothing when the host binding names another process start, without consulting an outer host', () => {
    const home = scratchHome();
    writeBinding(home, 30, { pid: 30, start: 'another-process', sessionId: SESSION_A });
    writeBinding(home, 10, { pid: 10, start: 'start-10', sessionId: SESSION_B });
    const table = {
      40: { ppid: 30, start: 'start-40', ...NPM_EXEC },
      30: { ppid: 10, start: 'start-30', comm: 'node', args: 'node /usr/local/bin/codex' },
      10: { ppid: 1, start: 'start-10', comm: 'claude', args: 'claude' },
    };
    expect(resolveSession(table, 40, home)).toBeNull();
  });
});
