import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'scripts');

type Layout = {
  sessionIdPattern: string;
  dir: string[];
  dirMode: string;
  file: string;
  fileMode: string;
  keys: string[];
  startLocale: string;
  nonHostCommands: string[];
  maxAncestors: number;
};
type HookGroup = { matcher?: string; hooks: { command: string }[] };
type HookManifest = { hooks: Record<string, HookGroup[]> };

const layout = JSON.parse(readFileSync(join(here, 'host-binding-layout.json'), 'utf8')) as Layout;
const readManifest = (name: string): HookManifest =>
  JSON.parse(readFileSync(join(here, '..', 'hooks', name), 'utf8')) as HookManifest;

const HOST_PID = 70002;
const RAW_START = '  Sat Nov 21  9:05:01   2026  ';
const START = 'Sat Nov 21 9:05:01 2026';
const SESSION = 'sess-host-binding-01';

const FAKE_PS = `#!/bin/sh
fields=""; pid=""
while [ $# -gt 0 ]; do
  case "$1" in
  -o) fields="$2"; shift 2 ;;
  -p) pid="$2"; shift 2 ;;
  *) shift ;;
  esac
done
printf '%s|%s|%s\\n' "$fields" "$pid" "\${LC_ALL:-}" >>"$FAKE_PS_LOG"
case "$fields" in *lstart*) [ -n "\${FAKE_PS_FAIL_LSTART:-}" ] && { printf '%s\\n' "$RAW_START_ON_FAILURE"; exit 1; } ;; esac
exec awk -F'|' -v pid="$pid" -v fields="$fields" '
$1 == pid {
  found = 1
  n = split(fields, f, ",")
  out = ""
  for (i = 1; i <= n; i++) {
    k = f[i]
    sub(/=$/, "", k)
    if (k == "ppid") v = sprintf("%6s", $2)
    else if (k == "comm") v = $3
    else if (k == "lstart") v = $4
    else v = ""
    out = out (i > 1 ? " " : "") v
  }
  print out
}
END { exit found ? 0 : 1 }' "$FAKE_PS_TABLE"
`;

let dir: string;
let home: string;
let bin: string;
let table: string;
let psLog: string;

type Proc = { pid: number; ppid: number; comm: string; start?: string };

function writeTable(procs: Proc[]): void {
  writeFileSync(
    table,
    procs.map((p) => `${p.pid}|${p.ppid}|${p.comm}|${p.start ?? RAW_START}`).join('\n') + '\n',
  );
}

/** The hook's parent is this test process; the host sits behind a shell. */
const shellThenHost = (): Proc[] => [
  { pid: process.pid, ppid: 70001, comm: '/bin/sh' },
  { pid: 70001, ppid: HOST_PID, comm: 'bash' },
  { pid: HOST_PID, ppid: 1, comm: '/usr/local/bin/claude' },
];

const bindingDir = (): string => join(home, ...layout.dir);
const bindingFile = (pid: number): string =>
  join(bindingDir(), layout.file.replace('{pid}', String(pid)));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rembric-host-binding-'));
  home = join(dir, 'home');
  bin = join(dir, 'bin');
  table = join(dir, 'ps-table');
  psLog = join(dir, 'ps-log');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), FAKE_PS, { mode: 0o755 });
  writeFileSync(psLog, '');
  writeTable(shellThenHost());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runHook(
  script: string,
  stdin: Record<string, unknown>,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    TMPDIR: dir,
    FAKE_PS_TABLE: table,
    FAKE_PS_LOG: psLog,
    ...extraEnv,
  };
  delete env.REMBRIC_SERVER_URL;
  delete env.REMBRIC_API_TOKEN;
  delete env.REMBRIC_PROJECT_SLUG;
  const child = execFileAsync('bash', [join(scripts, script), ...args], {
    encoding: 'utf8',
    cwd: dir,
    env,
  });
  child.child.stdin?.end(JSON.stringify({ cwd: dir, ...stdin }));
  return child;
}

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8).padStart(4, '0');

function writeBinding(pid: number, sessionId: string, start = START): void {
  mkdirSync(bindingDir(), { recursive: true, mode: 0o700 });
  writeFileSync(bindingFile(pid), JSON.stringify({ pid, start, sessionId }), { mode: 0o600 });
}

describe('SessionStart publishes the host binding', () => {
  it('writes <pid>.json for the nearest non-shell ancestor with the fixture layout', async () => {
    const { stdout } = await runHook(
      'session-start.sh',
      { session_id: SESSION, source: 'startup' },
      ['claude-code'],
    );

    const file = bindingFile(HOST_PID);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).toBe(JSON.stringify(parsed));
    expect(Object.keys(parsed)).toEqual(layout.keys);
    expect(parsed).toEqual({ pid: HOST_PID, start: START, sessionId: SESSION });
    expect(mode(bindingDir())).toBe(layout.dirMode);
    expect(mode(file)).toBe(layout.fileMode);
    expect(readdirSync(bindingDir())).toEqual([`${HOST_PID}.json`]);
    expect(stdout).toContain('rembric:');
  });

  it(`computes the start token with LC_ALL=${layout.startLocale}`, async () => {
    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['claude-code']);
    const lstartCalls = readFileSync(psLog, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('lstart='));
    expect(lstartCalls.length).toBeGreaterThan(0);
    for (const call of lstartCalls) expect(call.split('|')[2]).toBe(layout.startLocale);
  });

  it('skips every fixture non-host command and stops at the first other ancestor', async () => {
    const chain = layout.nonHostCommands;
    const pids = [process.pid, ...chain.slice(1).map((_, i) => 71001 + i)];
    const host = 71900;
    const outer = 71901;
    writeTable([
      ...chain.map((comm, i) => ({
        pid: pids[i]!,
        ppid: pids[i + 1] ?? host,
        comm: `/bin/${comm}`,
      })),
      { pid: host, ppid: 71950, comm: 'codex' },
      { pid: 71950, ppid: outer, comm: 'zsh' },
      { pid: outer, ppid: 1, comm: 'claude' },
    ]);
    expect(pids.length + 1).toBeLessThanOrEqual(layout.maxAncestors);

    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['codex-cli']);

    expect(readdirSync(bindingDir())).toEqual([`${host}.json`]);
  });

  it('never publishes for PID 1 when only shells sit above the hook', async () => {
    writeTable([
      { pid: process.pid, ppid: 1, comm: 'zsh' },
      { pid: 1, ppid: 0, comm: '/sbin/launchd' },
    ]);
    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['claude-code']);
    expect(existsSync(bindingDir()) ? readdirSync(bindingDir()) : []).toEqual([]);
  });

  const sessionStartRuns = (['hooks.json', 'hooks.codex.json'] as const).flatMap((manifest) => {
    const agent = manifest === 'hooks.json' ? 'claude-code' : 'codex-cli';
    return readManifest(manifest).hooks.SessionStart!.flatMap((group) =>
      group.hooks.flatMap((handler) => {
        const script = /scripts\/([a-z-]+\.sh)/.exec(handler.command)![1]!;
        return (group.matcher ?? '')
          .split('|')
          .map((source) => ({ manifest, agent, script, source }));
      }),
    );
  });

  it('covers both manifests and the compact source', () => {
    expect(sessionStartRuns.map((r) => `${r.agent}:${r.source}`)).toEqual(
      expect.arrayContaining([
        'claude-code:startup',
        'claude-code:resume',
        'claude-code:clear',
        'claude-code:compact',
        'codex-cli:startup',
        'codex-cli:resume',
        'codex-cli:clear',
        'codex-cli:compact',
      ]),
    );
  });

  it.each(sessionStartRuns)(
    '$manifest SessionStart source=$source ($script) publishes',
    async ({ agent, script, source }) => {
      await runHook(script, { session_id: SESSION, source }, [agent]);
      expect(JSON.parse(readFileSync(bindingFile(HOST_PID), 'utf8'))).toEqual({
        pid: HOST_PID,
        start: START,
        sessionId: SESSION,
      });
    },
  );

  it('replaces the previous binding of the same host on /clear', async () => {
    writeBinding(HOST_PID, 'sess-previous-0001');
    await runHook('session-start.sh', { session_id: SESSION, source: 'clear' }, ['claude-code']);
    expect(JSON.parse(readFileSync(bindingFile(HOST_PID), 'utf8'))).toMatchObject({
      sessionId: SESSION,
    });
  });

  it('publishes nothing and still exits 0 when ps fails, even with output', async () => {
    const { stdout } = await runHook(
      'session-start.sh',
      { session_id: SESSION, source: 'startup' },
      ['claude-code'],
      { FAKE_PS_FAIL_LSTART: '1', RAW_START_ON_FAILURE: RAW_START },
    );
    expect(existsSync(bindingFile(HOST_PID))).toBe(false);
    expect(stdout).toContain('rembric:');
  });

  it('publishes nothing when the start token is blank', async () => {
    writeTable([
      { pid: process.pid, ppid: HOST_PID, comm: 'sh' },
      { pid: HOST_PID, ppid: 1, comm: 'claude', start: '   ' },
    ]);
    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['claude-code']);
    expect(existsSync(bindingFile(HOST_PID))).toBe(false);
  });

  it('publishes nothing for a session id outside the fixture pattern', async () => {
    const bad = 'short';
    expect(new RegExp(layout.sessionIdPattern).test(bad)).toBe(false);
    await runHook('session-start.sh', { session_id: bad, source: 'startup' }, ['claude-code']);
    expect(existsSync(bindingDir()) ? readdirSync(bindingDir()) : []).toEqual([]);
  });

  it('prunes bindings whose process is gone or restarted and keeps live ones', async () => {
    writeTable([
      ...shellThenHost(),
      { pid: 72001, ppid: 1, comm: 'claude' },
      { pid: 72002, ppid: 1, comm: 'claude', start: 'Fri Nov 20 8:00:00 2026' },
    ]);
    writeBinding(72001, 'sess-live-000001');
    writeBinding(72002, 'sess-restarted-01');
    writeBinding(72003, 'sess-gone-000001');

    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['claude-code']);

    expect(readdirSync(bindingDir()).sort()).toEqual([`${HOST_PID}.json`, '72001.json']);
  });
});

describe('against the real ps', () => {
  it('publishes for this test process, the hook script’s non-shell parent', async () => {
    const real = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: layout.startLocale },
    })
      .replace(/\s+/g, ' ')
      .trim();
    expect(real).not.toBe('');

    await runHook('session-start.sh', { session_id: SESSION, source: 'startup' }, ['claude-code'], {
      PATH: process.env.PATH ?? '',
    });

    expect(JSON.parse(readFileSync(bindingFile(process.pid), 'utf8'))).toEqual({
      pid: process.pid,
      start: real,
      sessionId: SESSION,
    });
  });
});

describe('SessionEnd removes the host binding only for the ending session', () => {
  it('removes it when its sessionId equals the ending session', async () => {
    writeBinding(HOST_PID, SESSION);
    await runHook('session-end.sh', { session_id: SESSION, reason: 'exit' }, ['claude-code']);
    expect(existsSync(bindingFile(HOST_PID))).toBe(false);
  });

  it('keeps a binding that already names another session', async () => {
    writeBinding(HOST_PID, 'sess-next-000001');
    await runHook('session-end.sh', { session_id: SESSION, reason: 'clear' }, ['codex-cli']);
    expect(JSON.parse(readFileSync(bindingFile(HOST_PID), 'utf8'))).toMatchObject({
      sessionId: 'sess-next-000001',
    });
  });

  it('leaves another host’s binding for the same session alone', async () => {
    writeBinding(72001, SESSION);
    await runHook('session-end.sh', { session_id: SESSION, reason: 'exit' }, ['claude-code']);
    expect(existsSync(bindingFile(72001))).toBe(true);
  });
});

describe('plugin tests never publish into the real home', () => {
  it('every test file that runs a publishing hook overrides HOME', () => {
    const publishing = /(session-start|post-compact|session-end)\.sh/;
    const runs = /\b(execFile|execFileSync|execFileAsync|spawn|spawnSync)\b/;
    const offenders = readdirSync(here)
      .filter((name) => name.endsWith('.test.ts'))
      .filter((name) => {
        const source = readFileSync(join(here, name), 'utf8');
        return publishing.test(source) && runs.test(source) && !/\bHOME:/.test(source);
      });
    expect(offenders).toEqual([]);
  });
});
