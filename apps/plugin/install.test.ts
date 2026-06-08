import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The installer is POSIX sh; these tests drive it through its headless
// (non-interactive) surface — the arrow-key TUI needs a real /dev/tty and is
// verified by the operator. Everything here runs with REMBRIC_SRC pointed at
// the repo so the script reads artifacts from disk (cp), never the network.

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(PLUGIN_DIR, '..', '..');
const INSTALL_SH = join(PLUGIN_DIR, 'install.sh');

interface RunOpts {
  cwd?: string;
  home?: string;
  env?: Record<string, string>;
  path?: string;
}

function run(args: string[], opts: RunOpts = {}): { code: number; out: string } {
  const env: Record<string, string> = {
    REMBRIC_SRC: REPO_ROOT,
    REMBRIC_NONINTERACTIVE: '1',
    PATH: opts.path ?? process.env.PATH ?? '/usr/bin:/bin',
    HOME: opts.home ?? process.env.HOME ?? '/tmp',
    ...opts.env,
  };
  const res = spawnSync('/bin/sh', [INSTALL_SH, ...args], {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rembric-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'rembric-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('argument handling', () => {
  it('--help exits 0 with usage', () => {
    const { code, out } = run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('rembric installer');
    expect(out).toContain('--client=');
  });

  it('no flags (headless) refuses and exits non-zero', () => {
    const { code, out } = run([]);
    expect(code).toBe(2);
    expect(out).toContain('Interactive:');
  });

  it('--client without --action errors', () => {
    const { code, out } = run(['--client=opencode']);
    expect(code).toBe(2);
    expect(out).toContain('--client requires --action');
  });

  it('unknown client errors', () => {
    const { code, out } = run(['--client=bogus', '--action=install']);
    expect(code).toBe(2);
    expect(out).toContain('unknown client');
  });
});

describe('preflight', () => {
  it('aborts listing missing core tools when PATH is empty (remote mode)', () => {
    // Empty PATH + no REMBRIC_SRC → curl + core tools missing. command -v is a
    // shell builtin so preflight still runs and reports.
    const { code, out } = run(['--server'], { path: '/nonexistent', env: { REMBRIC_SRC: '' } });
    expect(code).toBe(1);
    expect(out).toContain('missing required tool');
  });
});

describe('server install', () => {
  it('fresh dir: generates a 64-hex token, prepares files, never starts docker', () => {
    const { code, out } = run(['--server', '--action=install'], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('Generated admin token');
    expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(true);
    const envText = readFileSync(join(dir, '.env'), 'utf8');
    const token = /^REMBRIC_ADMIN_TOKEN=([0-9a-f]+)$/m.exec(envText)?.[1];
    expect(token).toBeDefined();
    expect(token).toHaveLength(64);
    // Headless without --up must not bring the stack up.
    expect(out).not.toContain('Up. Dashboard');
  });

  it('interrupted run (empty token in existing .env) gets filled on re-run', () => {
    writeFileSync(join(dir, '.env'), 'REMBRIC_ADMIN_TOKEN=\n# REMBRIC_VERSION=\n');
    const { code, out } = run(['--server', '--action=install'], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('is empty');
    const token = /^REMBRIC_ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(
      readFileSync(join(dir, '.env'), 'utf8'),
    )?.[1];
    expect(token).toBeDefined();
  });

  it('configured .env is left untouched and its token shown', () => {
    writeFileSync(join(dir, '.env'), 'REMBRIC_ADMIN_TOKEN=existingtok123\n');
    const { code, out } = run(['--server', '--action=install'], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('already configured');
    expect(out).toContain('existingtok123');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('REMBRIC_ADMIN_TOKEN=existingtok123');
  });
});

describe('server update', () => {
  it('with a configured .env: refetches and offers the gated bring-up', () => {
    writeFileSync(join(dir, '.env'), 'REMBRIC_ADMIN_TOKEN=tok\n');
    const { code, out } = run(['--server', '--action=update'], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('Refetched');
    expect(out).toContain('docker compose pull && docker compose up -d');
  });

  it('without a .env: refuses to bring up and points to install', () => {
    const { code, out } = run(['--server', '--action=update'], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('No ./.env');
    expect(out).toContain('install first');
  });
});

describe('client routing', () => {
  it('codex install prints marketplace commands, copies nothing', () => {
    const { code, out } = run(['--client=codex', '--action=install'], { home });
    expect(code).toBe(0);
    expect(out).toContain('codex plugin marketplace add');
    expect(out).toContain('codex plugin install rembric');
  });

  it('claude uninstall prints the marketplace command and the conservative note', () => {
    const { out } = run(['--client=claude', '--action=uninstall'], { home });
    expect(out).toContain('claude plugin uninstall rembric@rembric');
    expect(out).toContain('Left in place');
  });

  it('opencode install then uninstall round-trips against a throwaway HOME', () => {
    const installed = join(home, '.config', 'opencode', 'plugins', 'rembric.ts');

    const ins = run(['--client=opencode', '--action=install'], { home });
    expect(ins.code).toBe(0);
    expect(existsSync(installed)).toBe(true);
    // The version comment survives the install rewrite (used for detection).
    expect(readFileSync(installed, 'utf8')).toMatch(/@rembric-plugin-version\s+\d+\.\d+\.\d+/);

    const un = run(['--client=opencode', '--action=uninstall'], { home });
    expect(un.code).toBe(0);
    expect(existsSync(installed)).toBe(false);
    expect(un.out).toContain('Left in place');
  });
});

describe('output degradation', () => {
  it('emits no ANSI escapes when stdout is not a terminal', () => {
    const { out } = run(['--help']);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });

  it('shows the plain wordmark (not the block banner) without a terminal', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const { out } = run(['--server', '--action=update'], { cwd: dir });
    expect(out).toContain('rembric installer');
    expect(out).not.toContain('██');
  });
});
