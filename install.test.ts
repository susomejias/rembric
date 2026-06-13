import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Tests for the whole installer system: the repo-root `install.sh` shim AND
// the `apps/plugin/install.sh` orchestrator it forwards to. Co-located with the
// root shim (the canonical entry point). Drives the installer through its
// headless (non-interactive) surface — the arrow-key TUI needs a real /dev/tty
// and is verified by the operator (see the rembric-tui-installer-e2e skill).
// Everything runs with REMBRIC_SRC pointed at the repo so the script reads
// artifacts from disk (cp), never the network.

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = join(REPO_ROOT, 'apps', 'plugin', 'install.sh');
const ROOT_SHIM = join(REPO_ROOT, 'install.sh');

// The installer reports each agent's "available" plugin version from
// .release-please-manifest.json per component. Derive expectations from the
// same source so a release-please bump doesn't break these tests.
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, '.release-please-manifest.json'), 'utf8'),
) as Record<string, string>;
const PLUGIN_VERSION: Record<string, string> = {
  claude: MANIFEST['apps/plugin/.claude-plugin'],
  codex: MANIFEST['apps/plugin/.codex-plugin'],
  hermes: MANIFEST['apps/plugin/.hermes-plugin'],
  opencode: MANIFEST['apps/plugin/.opencode-plugin'],
};

interface RunOpts {
  cwd?: string;
  home?: string;
  env?: Record<string, string>;
  path?: string;
  script?: string;
}

function run(args: string[], opts: RunOpts = {}): { code: number; out: string } {
  const env: Record<string, string> = {
    REMBRIC_SRC: REPO_ROOT,
    REMBRIC_NONINTERACTIVE: '1',
    REMBRIC_UPDATE_CHECK: 'off', // no GitHub network in tests unless a case opts in
    PATH: opts.path ?? process.env.PATH ?? '/usr/bin:/bin',
    HOME: opts.home ?? process.env.HOME ?? '/tmp',
    ...opts.env,
  };
  const res = spawnSync('/bin/sh', [opts.script ?? INSTALL_SH, ...args], {
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
  it('--help exits 0 and documents the full flag set', () => {
    const { code, out } = run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('rembric installer');
    for (const flag of [
      '--server',
      '--agent=',
      '--action=',
      '--status',
      '--json',
      '--token=',
      '--port=',
      '--up',
      '--ref=',
    ]) {
      expect(out).toContain(flag);
    }
  });

  it('no flags (headless) refuses and exits non-zero', () => {
    const { code, out } = run([]);
    expect(code).toBe(2);
    expect(out).toContain('Interactive:');
  });

  it('--agent without --action errors', () => {
    const { code, out } = run(['--agent=opencode']);
    expect(code).toBe(2);
    expect(out).toContain('--agent requires --action');
  });

  it('unknown agent errors', () => {
    const { code, out } = run(['--agent=bogus', '--action=install']);
    expect(code).toBe(2);
    expect(out).toContain('unknown agent');
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

describe('agent routing', () => {
  it('codex install prints marketplace commands, copies nothing', () => {
    const { code, out } = run(['--agent=codex', '--action=install'], { home });
    expect(code).toBe(0);
    expect(out).toContain('codex plugin marketplace add');
    expect(out).toContain('codex plugin install rembric');
  });

  it('claude uninstall prints the marketplace command and the conservative note', () => {
    const { out } = run(['--agent=claude', '--action=uninstall'], { home });
    expect(out).toContain('claude plugin uninstall rembric@rembric');
    expect(out).toContain('Left in place');
  });

  it('a comma-separated --agent list drives multiple agents in one run', () => {
    const { code, out } = run(['--agent=codex,claude', '--action=install'], { home });
    expect(code).toBe(0);
    expect(out).toContain('codex plugin install rembric');
    expect(out).toContain('claude plugin install rembric@rembric');
  });

  it('install surfaces the required post-install steps per agent', () => {
    const codex = run(['--agent=codex', '--action=install'], { home });
    expect(codex.out).toContain('codex features enable plugin_hooks');
    expect(codex.out).toContain('/hooks');
    const hermes = run(['--agent=hermes', '--action=install'], { home });
    expect(hermes.out).toContain('hermes plugins install rembric'); // triggers requires_env prompts
    expect(hermes.out).toContain('hermes plugins enable rembric');
    expect(hermes.out).toContain('hermes gateway restart');
  });

  it('uninstall does not print post-install "Next" steps', () => {
    const { out } = run(['--agent=codex', '--action=uninstall'], { home });
    expect(out).not.toContain('Next');
  });

  it('opencode install then uninstall round-trips against a throwaway HOME', () => {
    const installed = join(home, '.config', 'opencode', 'plugins', 'rembric.ts');

    const ins = run(['--agent=opencode', '--action=install'], { home });
    expect(ins.code).toBe(0);
    expect(existsSync(installed)).toBe(true);
    // The version comment survives the install rewrite (used for detection).
    expect(readFileSync(installed, 'utf8')).toMatch(/@rembric-plugin-version\s+\d+\.\d+\.\d+/);

    const un = run(['--agent=opencode', '--action=uninstall'], { home });
    expect(un.code).toBe(0);
    expect(existsSync(installed)).toBe(false);
    expect(un.out).toContain('Left in place');
  });
});

describe('root install.sh shim', () => {
  it('--help is identical to the plugin installer (pure forwarder)', () => {
    const root = run(['--help'], { script: ROOT_SHIM });
    const plugin = run(['--help']);
    expect(root.code).toBe(0);
    expect(root.out).toBe(plugin.out);
  });

  it('forwards flags: server install through the shim generates a token', () => {
    const { code, out } = run(['--server', '--action=install'], { script: ROOT_SHIM, cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain('Generated admin token');
    const token = /^REMBRIC_ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(
      readFileSync(join(dir, '.env'), 'utf8'),
    )?.[1];
    expect(token).toBeDefined();
  });
});

describe('agent CLI flags', () => {
  it('--status --json emits { server, agents } with valid shapes', () => {
    const { code, out } = run(['--status', '--json'], { home });
    expect(code).toBe(0);
    const data = JSON.parse(out);
    // server block: docker-observable state + image tag; latest_release is null
    // here (REMBRIC_UPDATE_CHECK=off → no GitHub call).
    expect(typeof data.server.state).toBe('string'); // running|exited|absent|unknown|…
    expect(data.server).toHaveProperty('version');
    expect(data.server.latest_release).toBeNull();
    // agents block: one object per agent.
    expect(data.agents.map((d) => d.agent)).toEqual(['claude', 'codex', 'hermes', 'opencode']);
    for (const d of data.agents) {
      expect(typeof d.present).toBe('boolean');
      expect(d.available).toBe(PLUGIN_VERSION[d.agent]); // from .release-please-manifest.json at the ref
      expect(d.installed).toBeNull(); // clean HOME → nothing installed
      expect(typeof d.action).toBe('string');
    }
  });

  it('--status surfaces the latest server release from the releases endpoint', () => {
    const releases = join(dir, 'releases.json');
    writeFileSync(
      releases,
      JSON.stringify([
        { tag_name: 'opencode-plugin-v0.10.0' }, // ignored (not server-v)
        { tag_name: 'server-v0.29.1' },
        { tag_name: 'server-v0.30.0' }, // highest server release
      ]),
    );
    const { code, out } = run(['--status', '--json'], {
      home,
      env: { REMBRIC_UPDATE_CHECK: 'on', REMBRIC_RELEASES_URL: `file://${releases}` },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).server.latest_release).toBe('0.30.0');
  });

  it('--status (text) prints the SERVER line and the aligned agent table', () => {
    const { code, out } = run(['--status'], { home });
    expect(code).toBe(0);
    expect(out).toContain('SERVER');
    expect(out).toContain('AGENT');
    expect(out).toContain('PLUGIN'); // clarifies the rows are about the plugin, not the agent
    expect(out).toContain('claude');
    expect(out).toContain(PLUGIN_VERSION.claude);
  });

  it('--token sets the admin token verbatim on server install', () => {
    const { code } = run(['--server', '--action=install', '--token=tok_ABC_1234567890'], {
      cwd: dir,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(
      /^REMBRIC_ADMIN_TOKEN=tok_ABC_1234567890$/m,
    );
  });

  it('--token shorter than 16 chars is refused (server would reject it)', () => {
    const { code, out } = run(['--server', '--action=install', '--token=short'], { cwd: dir });
    expect(code).not.toBe(0);
    expect(out).toContain('too short');
  });

  it('--port writes REMBRIC_PORT on server install', () => {
    const { code } = run(['--server', '--action=install', '--port=9001'], { cwd: dir });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/^REMBRIC_PORT=9001$/m);
  });
});

describe('server bring-up (--up) with a stubbed docker', () => {
  // A fake `docker` on PATH lets us exercise the `up` path (and its failure
  // modes) headlessly — no daemon. It answers the three subcommands bring_up
  // uses: `compose version` (deps check), `compose pull`, `compose up`.
  function fakeDockerDir(composeUp: 'ok' | 'conflict'): string {
    const d = mkdtempSync(join(tmpdir(), 'rembric-fakebin-'));
    const up =
      composeUp === 'conflict'
        ? `echo 'Error response from daemon: Conflict. The container name "/rembric" is already in use by container "abc123".' >&2; exit 1`
        : `echo '[+] Running 2/2'; exit 0`;
    writeFileSync(
      join(d, 'docker'),
      `#!/bin/sh
case "$1 $2" in
  "compose version") echo "Docker Compose version v2.31.0"; exit 0 ;;
  "compose pull") echo FAKEPULL; exit 0 ;;
  "compose up") ${up} ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(join(d, 'docker'), 0o755);
    return d;
  }

  it('success: brings the stack up and prints the dashboard URL + token', () => {
    const bin = fakeDockerDir('ok');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('Up. Dashboard');
    expect(out).toMatch(/Log in with admin token: [0-9a-f]{64}/);
  });

  it('--up honours --port (dashboard URL) and --token (login line)', () => {
    const bin = fakeDockerDir('ok');
    const { code, out } = run(
      ['--server', '--action=install', '--up', '--port=8799', '--token=tok_xyz_1234567890'],
      { cwd: dir, path: `${bin}:${process.env.PATH}` },
    );
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('127.0.0.1:8799/dashboard');
    expect(out).toContain('Log in with admin token: tok_xyz_1234567890');
  });

  it('REMBRIC_NO_PULL skips `docker compose pull` but still brings the stack up', () => {
    const bin = fakeDockerDir('ok');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
      env: { REMBRIC_NO_PULL: '1' },
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('REMBRIC_NO_PULL'); // the "pull skipped" notice
    expect(out).not.toContain('FAKEPULL'); // pull was NOT invoked
    expect(out).toContain('Up. Dashboard');
  });

  it('container-name conflict: friendly message, never clobbers, no raw daemon dump', () => {
    const bin = fakeDockerDir('conflict');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0); // handled gracefully, not a hard crash / set -e abort
    expect(out).toContain('already running');
    expect(out).toContain('docker rm -f rembric');
    expect(out).not.toContain('Error response from daemon');
  });
});

describe('server status reporting (stubbed docker)', () => {
  // A fake `docker` answering the calls server_state/server_image_version make:
  // `docker ps` (daemon reachable), `docker container inspect …{{.State.Status}}`,
  // `docker inspect …{{.Config.Image}}`.
  function fakeServerDocker(scenario: 'running-old' | 'absent' | 'daemon-down'): string {
    const d = mkdtempSync(join(tmpdir(), 'rembric-fakesrv-'));
    let body: string;
    if (scenario === 'running-old') {
      body = `case "$1" in
  ps) exit 0 ;;
  container) echo running ;;
  inspect) echo "ghcr.io/susomejias/rembric:0.20.0" ;;
  *) exit 0 ;;
esac`;
    } else if (scenario === 'absent') {
      body = `case "$1" in
  ps) exit 0 ;;
  container) exit 1 ;;
  inspect) exit 1 ;;
  *) exit 0 ;;
esac`;
    } else {
      body = 'exit 1'; // daemon unreachable: every docker call fails
    }
    writeFileSync(join(d, 'docker'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(d, 'docker'), 0o755);
    return d;
  }

  it('running container older than the latest release → update hint + versions', () => {
    const bin = fakeServerDocker('running-old');
    const releases = join(dir, 'rel.json');
    writeFileSync(releases, JSON.stringify([{ tag_name: 'server-v0.30.0' }]));
    const { code, out } = run(['--status'], {
      home,
      path: `${bin}:${process.env.PATH}`,
      env: { REMBRIC_UPDATE_CHECK: 'on', REMBRIC_RELEASES_URL: `file://${releases}` },
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('0.20.0'); // running image tag
    expect(out).toContain('0.30.0'); // latest release
    expect(out).toContain('update available');
  });

  it('no rembric container → state absent (--json)', () => {
    const bin = fakeServerDocker('absent');
    const { code, out } = run(['--status', '--json'], { home, path: `${bin}:${process.env.PATH}` });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    const s = JSON.parse(out).server;
    expect(s.state).toBe('absent');
    expect(s.version).toBeNull();
  });

  it('docker daemon unreachable → state unknown, never a crash (--json)', () => {
    const bin = fakeServerDocker('daemon-down');
    const { code, out } = run(['--status', '--json'], { home, path: `${bin}:${process.env.PATH}` });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(JSON.parse(out).server.state).toBe('unknown');
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
