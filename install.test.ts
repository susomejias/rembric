import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  chownSync,
  statSync,
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
  // All clients ship under the single unified `plugin` release-please component
  // (`apps/plugin`) — one shared version (unify-plugin-release-track).
  claude: MANIFEST['apps/plugin'],
  codex: MANIFEST['apps/plugin'],
  hermes: MANIFEST['apps/plugin'],
  opencode: MANIFEST['apps/plugin'],
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
    expect(out).not.toContain('Up.');
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
    expect(out).toContain('codex plugin add rembric@rembric');
  });

  it('claude uninstall prints the marketplace command and the conservative note', () => {
    const { out } = run(['--agent=claude', '--action=uninstall'], { home });
    expect(out).toContain('claude plugin uninstall rembric@rembric');
    expect(out).toContain('Left in place');
  });

  it('claude/codex update use their real upgrade commands, not re-install', () => {
    const claude = run(['--agent=claude', '--action=update'], { home });
    expect(claude.code).toBe(0);
    expect(claude.out).toContain('claude plugin update rembric@rembric');
    expect(claude.out).not.toContain('claude plugin install'); // update ≠ re-install
    expect(claude.out).not.toContain('marketplace add'); // marketplace already added

    const codex = run(['--agent=codex', '--action=update'], { home });
    expect(codex.code).toBe(0);
    expect(codex.out).toContain('codex plugin marketplace upgrade rembric');
    expect(codex.out).not.toContain('codex plugin install'); // no such subcommand in the Codex CLI
  });

  it('a comma-separated --agent list drives multiple agents in one run', () => {
    const { code, out } = run(['--agent=codex,claude', '--action=install'], { home });
    expect(code).toBe(0);
    expect(out).toContain('codex plugin add rembric@rembric');
    expect(out).toContain('claude plugin install rembric@rembric');
  });

  it('install surfaces the required post-install steps per agent', () => {
    const codex = run(['--agent=codex', '--action=install'], { home });
    expect(codex.out).not.toContain('plugin_hooks'); // flag removed upstream in codex-cli 0.142.3+
    expect(codex.out).toContain('/hooks');
    const hermes = run(['--agent=hermes', '--action=install'], { home });
    expect(hermes.out).toContain('hermes plugins install rembric'); // triggers requires_env prompts
    expect(hermes.out).toContain('hermes plugins enable rembric');
    expect(hermes.out).toContain('hermes gateway restart');
  });

  it('hermes update only reminds to restart the gateway (already installed/enabled)', () => {
    const { code, out } = run(['--agent=hermes', '--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('hermes gateway restart');
    // The install-only wiring step must not be suggested on an update.
    expect(out).not.toContain('hermes plugins install rembric');
  });

  it('opencode/claude update notes drop the install-only wiring (just restart)', () => {
    const opencode = run(['--agent=opencode', '--action=update'], { home });
    expect(opencode.code).toBe(0);
    expect(opencode.out).toContain('restart opencode');
    expect(opencode.out).not.toContain('paste the printed MCP block'); // install-only

    const claude = run(['--agent=claude', '--action=update'], { home });
    expect(claude.code).toBe(0);
    expect(claude.out).toContain('restart Claude Code');
    expect(claude.out).not.toContain('prompts for the server URL'); // install-only
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

describe('--action=update with no --agent (update-all)', () => {
  // #262 / memory.about's `update_all` command: before this feature, a bare
  // `--action=update` errored ("--agent requires --action" is backwards —
  // actually it fell through to the usage error because ARG_AGENTS was
  // empty). This section proves the fix: it updates only what has an update
  // available and never errors, even with nothing installed.

  function ageOpencodePlugin(version: string): void {
    const dir = join(home, '.config', 'opencode', 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rembric.ts'),
      `// @rembric-plugin-version ${version}\nimport { readRembricSlug } from './lib/rembric-dotenv.mjs';\nexport const RembricPlugin = () => ({});\n`,
    );
  }

  it('updates only the installed-and-outdated agent, skips the rest, never errors', () => {
    ageOpencodePlugin('0.0.1'); // older than PLUGIN_VERSION.opencode from the manifest
    const { code, out } = run(['--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('Updating all plugins with an update available');
    // opencode was outdated → updated (its update note, not the install-only one).
    expect(out).toContain('restart opencode');
    expect(out).not.toContain('paste the printed MCP block');
    // claude/codex/hermes were never installed → skipped, not errored.
    expect(out).toContain('claude: not installed — skipped');
    expect(out).toContain('codex: not installed — skipped');
    expect(out).toContain('hermes: not installed — skipped');
    expect(out).toContain('Done: 1 updated, 3 skipped.');
  });

  it('with nothing installed, updates nothing and still exits 0', () => {
    const { code, out } = run(['--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('Done: 0 updated, 4 skipped.');
  });

  it('--agent=all --action=update is an explicit alias for the same behavior', () => {
    ageOpencodePlugin('0.0.1');
    const { code, out } = run(['--agent=all', '--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('Done: 1 updated, 3 skipped.');
  });

  it('an up-to-date agent is skipped as "up to date", not re-updated', () => {
    ageOpencodePlugin(PLUGIN_VERSION.opencode); // matches the manifest exactly
    const { code, out } = run(['--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('opencode: up to date — skipped');
    expect(out).toContain('Done: 0 updated, 4 skipped.');
  });
});

describe('opencode installer verifications', () => {
  const OPENCODE_INSTALL = join(REPO_ROOT, 'apps', 'plugin', '.opencode-plugin', 'install.sh');

  it('is idempotent: a second install produces byte-identical files', () => {
    const files = [
      join(home, '.config', 'opencode', 'plugins', 'rembric.ts'),
      join(home, '.config', 'opencode', 'opencode.json'),
      join(home, '.config', 'rembric', 'bin', 'rembric-bridge.mjs'),
      join(home, '.config', 'rembric', 'bin', 'rembric-dotenv.mjs'),
    ];
    const first = run(['--agent=opencode', '--action=install'], { home });
    expect(first.code).toBe(0);
    const snapshot = files.map((f) => readFileSync(f, 'utf8'));
    const second = run(['--agent=opencode', '--action=install'], { home });
    expect(second.code).toBe(0);
    expect(second.out).toContain('already has mcp.rembric'); // config detected, not re-written
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(snapshot);
  });

  it('an unrelated "rembric" string elsewhere in opencode.json is NOT treated as configured', () => {
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    const cfg = JSON.stringify({ mcp: { 'rembric-foo': { type: 'local' } }, theme: 'rembric' });
    writeFileSync(join(cfgDir, 'opencode.json'), cfg);
    const { code, out } = run(['--agent=opencode', '--action=install'], { home });
    expect(code).toBe(0);
    expect(out).toContain('manual merge required');
    expect(readFileSync(join(cfgDir, 'opencode.json'), 'utf8')).toBe(cfg); // untouched
  });

  it('a real mcp.rembric entry is detected as already configured', () => {
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    const cfg = JSON.stringify({ mcp: { rembric: { type: 'local', enabled: true } } });
    writeFileSync(join(cfgDir, 'opencode.json'), cfg);
    const { out } = run(['--agent=opencode', '--action=install'], { home });
    expect(out).toContain('already has mcp.rembric');
    expect(readFileSync(join(cfgDir, 'opencode.json'), 'utf8')).toBe(cfg);
  });

  it('aborts loudly and removes the partial plugin when the import rewrite no-ops', () => {
    const drift = mkdtempSync(join(tmpdir(), 'rembric-drift-'));
    writeFileSync(
      join(drift, 'plugin.ts'),
      `// @rembric-plugin-version 0.0.0\nimport { readRembricSlug } from './lib/rembric-dotenv.mjs';\nexport const RembricPlugin = () => ({});\n`,
    );
    const { code, out } = run([], {
      home,
      script: OPENCODE_INSTALL,
      env: { PLUGIN_SRC: drift, BIN_SRC: join(REPO_ROOT, 'apps', 'plugin', 'bin') },
    });
    rmSync(drift, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(out).toContain('rewrite failed');
    expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'rembric.ts'))).toBe(false);
  });
});

describe('--yes runs the marketplace command (stubbed client binary)', () => {
  // A fake `claude`/`codex` first on PATH lets us assert the run-through
  // headlessly: the stub echoes a sentinel with its args so we can tell
  // "executed" from "merely printed". Core tools live in /usr/bin:/bin, so the
  // absent-binary case points PATH there (claude/codex are not system bins).
  const CORE_PATH = '/usr/bin:/bin';
  function fakeClientBinDir(name: 'claude' | 'codex'): string {
    const d = mkdtempSync(join(tmpdir(), 'rembric-fakeclient-'));
    writeFileSync(join(d, name), `#!/bin/sh\necho "RAN:${name} $*"\n`);
    chmodSync(join(d, name), 0o755);
    return d;
  }

  it('--yes executes the claude update command when the claude binary is present', () => {
    const bin = fakeClientBinDir('claude');
    const { code, out } = run(['--agent=claude', '--action=update', '--yes'], {
      home,
      path: `${bin}:${CORE_PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('claude plugin update rembric@rembric'); // still printed
    expect(out).toContain('RAN:claude plugin update rembric@rembric'); // and executed
  });

  it('-y is an alias for --yes', () => {
    const bin = fakeClientBinDir('claude');
    const { code, out } = run(['--agent=claude', '--action=update', '-y'], {
      home,
      path: `${bin}:${CORE_PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('RAN:claude plugin update rembric@rembric');
  });

  it('--yes executes the codex upgrade command when the codex binary is present', () => {
    const bin = fakeClientBinDir('codex');
    const { code, out } = run(['--agent=codex', '--action=update', '--yes'], {
      home,
      path: `${bin}:${CORE_PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('RAN:codex plugin marketplace upgrade rembric');
  });

  it('without --yes a headless run only prints, never executes', () => {
    const bin = fakeClientBinDir('claude');
    const { code, out } = run(['--agent=claude', '--action=update'], {
      home,
      path: `${bin}:${CORE_PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('claude plugin update rembric@rembric'); // printed
    expect(out).not.toContain('RAN:claude'); // not executed
  });

  it('--yes with an absent client binary prints but executes nothing', () => {
    const { code, out } = run(['--agent=codex', '--action=update', '--yes'], {
      home,
      path: CORE_PATH, // no codex on PATH
    });
    expect(code).toBe(0);
    expect(out).toContain('codex plugin marketplace upgrade rembric'); // printed
    expect(out).not.toContain('RAN:codex'); // nothing ran
  });

  it('--help documents the --yes / -y flag', () => {
    const { out } = run(['--help']);
    expect(out).toContain('--yes');
    expect(out).toContain('-y');
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

  it('--port=abc is rejected at parse time, before any .env write', () => {
    const { code, out } = run(['--server', '--action=install', '--port=abc'], { cwd: dir });
    expect(code).toBe(2);
    expect(out).toContain('invalid --port=abc');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('--port out of range (70000) is rejected', () => {
    const { code, out } = run(['--server', '--action=install', '--port=70000'], { cwd: dir });
    expect(code).toBe(2);
    expect(out).toContain('invalid --port=70000');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });
});

describe('server bring-up (--up) with a stubbed docker', () => {
  // A fake `docker` on PATH lets us exercise the `up` path (and its failure
  // modes) headlessly — no daemon. It answers the three subcommands bring_up
  // uses: `compose version` (deps check), `compose pull`, `compose up`.
  // A fake `curl` answers the post-up /healthz poll ('healthy' → {ok:true},
  // 'down' → connection refused rc 7), and a no-op `sleep` collapses the
  // ~30s poll ceiling so the down case stays fast.
  function fakeDockerDir(
    composeUp: 'ok' | 'conflict',
    healthz: 'healthy' | 'down' = 'healthy',
    chown: 'ok' | 'fail' = 'ok',
  ): string {
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
    const curl =
      healthz === 'healthy'
        ? `#!/bin/sh\nprintf '{"ok":true,"version":"9.9.9"}'\nexit 0\n`
        : `#!/bin/sh\nexit 7\n`;
    writeFileSync(join(d, 'curl'), curl);
    chmodSync(join(d, 'curl'), 0o755);
    writeFileSync(join(d, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(d, 'sleep'), 0o755);
    // Stubbed so the test controls the chown-vs-chmod-fallback branch
    // independently of whether the test runner itself happens to be root.
    writeFileSync(join(d, 'chown'), chown === 'ok' ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\nexit 1\n');
    chmodSync(join(d, 'chown'), 0o755);
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
    expect(out).toContain('Up.');
    expect(out).toContain('127.0.0.1:8787/dashboard');
    expect(out).toMatch(/Log in with admin token: [0-9a-f]{64}/);
  });

  it('healthy /healthz: success banner reports the server version from the response', () => {
    const bin = fakeDockerDir('ok', 'healthy');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain('Up.');
    expect(out).toContain('9.9.9'); // version parsed from the stubbed healthz JSON
    expect(out).toContain('127.0.0.1:8787/dashboard');
  });

  it('unreachable /healthz: withholds the success banner and hints at docker compose logs', () => {
    const bin = fakeDockerDir('ok', 'down');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0); // bounded failure, never a set -e abort
    expect(out).not.toContain('Up.');
    expect(out).not.toContain('/dashboard');
    expect(out).not.toContain('Log in with admin token');
    expect(out).toContain('docker compose logs');
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
    expect(out).toContain('Up.');
  });

  it('creates ./data and chowns it to uid 10001 when chown succeeds (no chmod fallback noise)', () => {
    const bin = fakeDockerDir('ok', 'healthy', 'ok');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'data'))).toBe(true);
    expect(out).not.toContain('Could not chown');
  });

  it('falls back to a world-writable ./data and warns when a FRESH directory is not owned by uid 10001 and chown is not possible', () => {
    const bin = fakeDockerDir('ok', 'healthy', 'fail');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    const dataDir = join(dir, 'data');
    expect(existsSync(dataDir)).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o777);
    expect(out).toContain('Could not chown ./data to the container');
    expect(out).toContain('sudo chown -R 10001:10001 ./data');
  });

  it('does NOT relax an existing ./data already owned by uid 10001, even when chown is not possible', () => {
    // Regression guard: chown fails on every non-root invocation regardless
    // of whether ./data is already fine (e.g. fixed by a prior manual `sudo
    // chown`, or working transparently under Docker Desktop) — that failure
    // alone must never cause a re-run to downgrade an already-correct,
    // already-working install to world-writable.
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { mode: 0o750 });
    chownSync(dataDir, 10001, 10001);
    const bin = fakeDockerDir('ok', 'healthy', 'fail');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(statSync(dataDir).uid).toBe(10001);
    expect(statSync(dataDir).mode & 0o777).toBe(0o750); // unchanged, NOT widened to 0777
    expect(out).not.toContain('Could not chown');
    expect(out).not.toContain('world-writable');
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
