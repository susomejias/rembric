import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const INSTALLER_SRC = readFileSync(INSTALL_SH, 'utf8');

// The regex requires the installer to keep its single-line `CLIENTS='…'` form.
const CLIENTS: string[] = (() => {
  const m = /^CLIENTS='([^']+)'$/m.exec(INSTALLER_SRC);
  if (!m) throw new Error('apps/plugin/install.sh has no single CLIENTS= definition');
  return m[1].split(' ');
})();

// The verbs `--action` accepts, parsed from the installer's single definition
// so the expectations below cannot drift from what the parser allows. Same
// single-line requirement as CLIENTS.
const ACTIONS: string[] = (() => {
  const m = /^ACTIONS='([^']+)'$/m.exec(INSTALLER_SRC);
  if (!m) throw new Error('apps/plugin/install.sh has no single ACTIONS= definition');
  return m[1].split(' ');
})();

// The status table's ACTION column prints one of these when the state warrants
// no action at all. Everything else in that column must be an ACTIONS verb.
const NON_RECOMMENDATIONS = ['up to date', 'ahead', '-'];

// Core tools live in /usr/bin:/bin and no client binary does, so a case that
// needs a client to look absent points PATH here.
const CORE_PATH = '/usr/bin:/bin';

// A stub client binary first on PATH, wherever a test needs that client to look
// present. The real one must never run from the suite — it would install into
// the developer's own configuration — and the `RAN:` sentinel is what
// distinguishes "executed" from "merely printed".
function fakeClientBinDir(name: 'claude' | 'codex' | 'pi'): string {
  const d = mkdtempSync(join(tmpdir(), 'rembric-fakeclient-'));
  writeFileSync(join(d, name), `#!/bin/sh\necho "RAN:${name} $*"\n`);
  chmodSync(join(d, name), 0o755);
  return d;
}

const PI_STUB_DIR = fakeClientBinDir('pi');
afterAll(() => rmSync(PI_STUB_DIR, { recursive: true, force: true }));

const PLUGIN_VERSION: Record<string, string> = Object.fromEntries(
  // All clients ship under the single unified `plugin` release-please component
  // (`apps/plugin`) — one shared version (unify-plugin-release-track).
  CLIENTS.map((c) => [c, MANIFEST['apps/plugin']]),
);

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
    for (const c of CLIENTS) expect(out).toContain(c); // the --agent list derives from CLIENTS
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

  it('an unrecognised --action is refused at parse time, before anything runs', () => {
    // --yes is on so the run WOULD execute the client CLI if it got that far.
    const opts = { home, path: `${PI_STUB_DIR}:${CORE_PATH}` };
    const { code, out } = run(['--agent=pi', '--action=bogus', '--yes'], opts);
    expect(code).toBe(2);
    expect(out).toContain('invalid --action=bogus');
    for (const a of ACTIONS) expect(out).toContain(a); // the error names what is accepted
    // The pre-fix failure was silent success: no command, no error, and the
    // post-install "Next" steps printed as if something had been installed.
    expect(out).not.toContain('RAN:pi');
    expect(out).not.toContain('Next');

    // Control: the same invocation with an accepted verb does all three.
    const ok = run(['--agent=pi', '--action=install', '--yes'], opts);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('RAN:pi');
    expect(ok.out).toContain('Next');
  });

  it('--server refuses an action it has no backend for', () => {
    // do_server treats every non-`update` action as install, so accepting
    // `uninstall` here would install under an "uninstall" heading.
    const { code, out } = run(['--server', '--action=uninstall'], { cwd: dir });
    expect(code).toBe(2);
    expect(out).toContain('--server accepts --action=install|update');
    expect(existsSync(join(dir, '.env'))).toBe(false);
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
  // available and never errors.

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
    expect(out).toContain(`Done: 1 updated, ${CLIENTS.length - 1} skipped.`);
  });

  it('--agent=all --action=update is an explicit alias for the same behavior', () => {
    ageOpencodePlugin('0.0.1');
    const { code, out } = run(['--agent=all', '--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain(`Done: 1 updated, ${CLIENTS.length - 1} skipped.`);
  });

  it('an up-to-date agent is skipped as "up to date", not re-updated', () => {
    ageOpencodePlugin(PLUGIN_VERSION.opencode); // matches the manifest exactly
    const { code, out } = run(['--action=update'], { home });
    expect(code).toBe(0);
    expect(out).toContain('opencode: up to date — skipped');
    expect(out).toContain(`Done: 0 updated, ${CLIENTS.length} skipped.`);
  });
});

describe('the client set has a single definition every surface agrees with', () => {
  it('is exactly the five supported clients, in a stable order', () => {
    // The literal contract, and the non-vacuity control for every assertion
    // below that derives its expectation from CLIENTS.
    expect(CLIENTS).toEqual(['claude', 'codex', 'hermes', 'opencode', 'pi']);
  });

  it('no second line in the installer enumerates the client set', () => {
    const enumerating = INSTALLER_SRC.split('\n').filter(
      (line) => CLIENTS.filter((c) => new RegExp(`\\b${c}\\b`).test(line)).length >= 4,
    );
    expect(enumerating).toEqual([`CLIENTS='${CLIENTS.join(' ')}'`]);
  });

  it('the interactive agent menu and its index mapping both derive from it', () => {
    // The arrow-key menu needs a real /dev/tty, so this is asserted at the
    // source: the entries are the set itself, and the selected index is mapped
    // back through it rather than through a hand-written case ladder.
    expect(INSTALLER_SRC).toContain('arrow_menu "Which agent?" "all — update outdated" $CLIENTS');
    expect(INSTALLER_SRC).toContain('c=$(client_at "$MENU_INDEX")');
  });

  it('--status --json emits one entry per client, in the same order', () => {
    const { code, out } = run(['--status', '--json'], { home });
    expect(code).toBe(0);
    expect(JSON.parse(out).agents.map((a: { agent: string }) => a.agent)).toEqual(CLIENTS);
  });

  it('update-all accounts for every client in the set', () => {
    const { code, out } = run(['--action=update'], { home });
    expect(code).toBe(0);
    for (const c of CLIENTS) expect(out).toMatch(new RegExp(`^  ${c}: `, 'm'));
    expect(out).toContain(`Done: 0 updated, ${CLIENTS.length} skipped.`);
  });

  it.each(CLIENTS)('--agent=%s is routed to a backend and has post-install steps', (client) => {
    const { code, out } = run([`--agent=${client}`, '--action=install'], {
      home,
      path: `${PI_STUB_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    });
    expect(code).toBe(0);
    expect(out).not.toContain('unknown agent');
    expect(out).toContain(`${client} (install)`);
    // A client in the set with no post_install_notes arm would install and then
    // say nothing about the wiring it still needs.
    expect(out).toContain('Next');
  });

  it('every client has a presence adapter (an unmatched case would report present)', () => {
    // /usr/bin:/bin holds none of the client binaries and HOME is throwaway, so
    // every row must read absent. A client missing from client_present's case
    // falls through, and an empty `case` exits 0 — i.e. reports itself present.
    const { out } = run(['--status', '--json'], { home, path: '/usr/bin:/bin' });
    const agents = JSON.parse(out).agents as { agent: string; present: boolean }[];
    expect(agents.map((a) => a.present)).toEqual(CLIENTS.map(() => false));
  });
});

describe('the ACTION column recommends only actions --action accepts', () => {
  // The three surfaces derived from client_state print different things: the
  // table prints the recommended VERB, `--status --json` carries the detected
  // STATE, and update-all names the verb it would take. The column used to
  // print `reinstall`, which is not a verb the parser accepts — following the
  // table exited 0 having run nothing, or died inside `eval` under --yes.

  function tableRows(out: string): { agent: string; action: string }[] {
    return out
      .split('\n')
      .map((line) => line.split(/\s{2,}/).filter(Boolean))
      .filter((cells) => cells.length === 5 && CLIENTS.includes(cells[0]))
      .map((cells) => ({ agent: cells[0], action: cells[4] }));
  }

  function writeOpencodePlugin(version: string): void {
    const d = join(home, '.config', 'opencode', 'plugins');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'rembric.ts'), `// @rembric-plugin-version ${version}\n`);
  }

  it('no cell in any detectable state is outside the accepted verbs', () => {
    const withPi = { home, path: `${PI_STUB_DIR}:${CORE_PATH}` };
    // One scenario per state that reaches the column: not installed (install),
    // installed-and-old (update), installed-and-current (up to date), ahead of
    // the published version, and present-but-unreadable (the pi row).
    const scenarios = [
      () => undefined,
      () => writeOpencodePlugin('0.0.1'),
      () => writeOpencodePlugin(PLUGIN_VERSION.opencode),
      () => writeOpencodePlugin('99.0.0'),
    ];
    const seen = new Set<string>();
    for (const setup of scenarios) {
      setup();
      const rows = tableRows(run(['--status'], withPi).out);
      // Non-vacuity: an unparsed table would make every assertion below empty.
      expect(rows.map((r) => r.agent)).toEqual(CLIENTS);
      for (const row of rows) {
        expect([...ACTIONS, ...NON_RECOMMENDATIONS]).toContain(row.action);
        seen.add(row.action);
      }
    }
    // …and the scenarios really did exercise more than one outcome.
    expect(seen.size).toBeGreaterThan(2);
  });

  it('following the recommendation the table prints resolves to a real action', () => {
    const withPi = { home, path: `${PI_STUB_DIR}:${CORE_PATH}` };
    const pi = tableRows(run(['--status'], withPi).out).find((r) => r.agent === 'pi');
    expect(pi).toBeDefined();
    expect(ACTIONS).toContain(pi!.action);

    const followed = run(['--agent=pi', `--action=${pi!.action}`, '--yes'], withPi);
    expect(followed.code).toBe(0);
    expect(followed.out).toContain('RAN:pi');
    expect(followed.out).not.toMatch(/invalid --action|parameter not set|unsupported action/);
  });

  it.each(ACTIONS)(
    '--yes with --action=%s reaches a real command, never an unset one',
    (action) => {
      const { code, out } = run(['--agent=pi', `--action=${action}`, '--yes'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
      });
      expect(code).toBe(0);
      // `cmd: parameter not set` was the --yes symptom of an unmatched action.
      expect(out).not.toMatch(/parameter not set|unbound variable|unsupported action/);
      expect(out).toContain('RAN:pi');
    },
  );

  it("the CLI backend's action table has one arm per verb and fails closed", () => {
    // Unreachable from the CLI now that the parser refuses unknown verbs, so it
    // is asserted at the source: an unmatched POSIX `case` exits 0, which is
    // what made the original failure silent.
    const block = /client_cli_cmds\(\)[\s\S]*?\n {2}case "\$action" in\n([\s\S]*?)\n {2}esac/.exec(
      INSTALLER_SRC,
    );
    expect(block).not.toBeNull();
    const arms = [...block![1].matchAll(/^ {4}([a-z]+|\*)\)/gm)].map((m) => m[1]);
    expect(arms).toContain('*');
    expect(arms.filter((a) => a !== '*').sort()).toEqual([...ACTIONS].sort());
  });

  it('update-all names a verb the parser accepts when it declines to act', () => {
    const { code, out } = run(['--action=update', '--yes'], {
      home,
      path: `${PI_STUB_DIR}:${CORE_PATH}`,
    });
    expect(code).toBe(0);
    const hint = /pi: version unknown — skipped \(use --agent=pi --action=(\S+) to force\)/.exec(
      out,
    );
    expect(hint).not.toBeNull();
    expect(ACTIONS).toContain(hint![1]);
  });
});

describe('pi (registry-CLI backend)', () => {
  // The third backend: no repo-side script, no marketplace — the client's own
  // CLI resolving a package from the public npm registry.
  const piAgent = (root: string): string => join(root, 'npm', 'node_modules', '@rembric', 'pi');

  function installedFixture(agentDir: string, version: string): void {
    const pkg = piAgent(agentDir);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      `${JSON.stringify({ name: '@rembric/pi', version }, null, 2)}\n`,
    );
  }

  function piRow(out: string): string {
    return out.split('\n').find((l) => /^ {2}pi\s/.test(l)) ?? '';
  }

  it('has no repo-side install or uninstall script', () => {
    const piPlugin = join(REPO_ROOT, 'apps', 'plugin', '.pi-plugin');
    expect(existsSync(join(piPlugin, 'install.sh'))).toBe(false);
    expect(existsSync(join(piPlugin, 'uninstall.sh'))).toBe(false);
  });

  it('install and update print the SAME unpinned command, even under --ref', () => {
    const spec = 'pi install npm:@rembric/pi';
    const ins = run(['--agent=pi', '--action=install'], { home, path: CORE_PATH });
    const upd = run(['--agent=pi', '--action=update'], { home, path: CORE_PATH });
    const pinned = run(['--agent=pi', '--action=install', '--ref=v9.9.9'], {
      home,
      path: CORE_PATH,
    });
    expect(ins.code).toBe(0);
    expect(upd.code).toBe(0);
    expect(pinned.code).toBe(0);
    for (const { out } of [ins, upd, pinned]) {
      expect(out).toContain(spec);
      // A version-pinned spec is skipped by the client's own update commands,
      // so it would freeze the operator while reporting success.
      expect(out).not.toMatch(/@rembric\/pi@/);
    }
    // --ref names a git ref; this artifact comes from the registry.
    expect(pinned.out).not.toContain('9.9.9');
  });

  it("uninstall routes to the client's own removal verb and keeps credentials", () => {
    const { code, out } = run(['--agent=pi', '--action=uninstall'], { home, path: CORE_PATH });
    expect(code).toBe(0);
    expect(out).toContain('pi remove npm:@rembric/pi');
    expect(out).toContain('Left in place');
    expect(out).not.toContain('Next');
  });

  it('install prints the shell-environment step and offers no settings-file alternative', () => {
    const { out } = run(['--agent=pi', '--action=install'], { home, path: CORE_PATH });
    expect(out).toContain('REMBRIC_SERVER_URL');
    expect(out).toContain('REMBRIC_API_TOKEN');
    // Measured: this harness injects nothing from its own settings file, so a
    // settings-file step would be an invented path.
    expect(out).not.toMatch(/settings/i);
  });

  it('update prints only the restart, not the install-only credential step', () => {
    const { out } = run(['--agent=pi', '--action=update'], { home, path: CORE_PATH });
    expect(out).toContain('restart Pi');
    expect(out).not.toContain('REMBRIC_API_TOKEN');
  });

  it('--yes runs the registry command when the binary is present, and nothing when absent', () => {
    const present = run(['--agent=pi', '--action=install', '--yes'], {
      home,
      path: `${PI_STUB_DIR}:${CORE_PATH}`,
    });
    expect(present.code).toBe(0);
    expect(present.out).toContain('RAN:pi install npm:@rembric/pi');

    const noFlag = run(['--agent=pi', '--action=install'], {
      home,
      path: `${PI_STUB_DIR}:${CORE_PATH}`,
    });
    expect(noFlag.out).toContain('pi install npm:@rembric/pi'); // printed
    expect(noFlag.out).not.toContain('RAN:pi'); // never executed

    const absent = run(['--agent=pi', '--action=install', '--yes'], { home, path: CORE_PATH });
    expect(absent.out).toContain('pi install npm:@rembric/pi');
    expect(absent.out).not.toContain('RAN:pi');
  });

  describe('installed-version detection', () => {
    // Measured against Pi 0.84.1: a user-scope `pi install npm:<pkg>` always
    // leaves the package manifest under <agentDir>/npm/node_modules/, and that
    // is the same file Pi reads for its own update check. The other install
    // vectors (local path, project scope, pre-0.75.1 global) leave no version
    // on disk at all.
    it('reads the version from the deterministic location under PI_CODING_AGENT_DIR', () => {
      const agentDir = join(home, 'piagent');
      installedFixture(agentDir, '0.0.1');
      const { out } = run(['--status'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      expect(piRow(out)).toContain('0.0.1');
      expect(piRow(out)).toContain('update');

      installedFixture(agentDir, PLUGIN_VERSION.pi);
      const current = run(['--status'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      expect(piRow(current.out)).toContain('up to date');
    });

    it('defaults to ~/.pi/agent when PI_CODING_AGENT_DIR is unset', () => {
      installedFixture(join(home, '.pi', 'agent'), '0.0.2');
      const { out } = run(['--status'], { home, path: `${PI_STUB_DIR}:${CORE_PATH}` });
      expect(piRow(out)).toContain('0.0.2');
    });

    it('reads a prerelease version whole, not truncated to its release core', () => {
      // The digits-only extraction the other four adapters use returns empty or
      // a truncated `9.9.9` here, which would make vercmp compare the wrong
      // value and the table state a version that is not installed.
      const agentDir = join(home, 'piagent');
      installedFixture(agentDir, '9.9.9-rc.1');
      const { out } = run(['--status'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      expect(piRow(out)).toContain('9.9.9-rc.1');
    });

    it('renders unknown + the idempotent install verb when no version is on disk', () => {
      const { code, out } = run(['--status'], { home, path: `${PI_STUB_DIR}:${CORE_PATH}` });
      expect(code).toBe(0);
      expect(piRow(out)).toContain('unknown');
      // The recommendation under ignorance is the idempotent reinstall, printed
      // as the verb `--action` accepts so following the table literally works.
      const action = piRow(out)
        .trim()
        .split(/\s{2,}/)
        .at(-1);
      expect(action).toBe('install');
      expect(ACTIONS).toContain(action);
      // The table's "update available" must never lie: an unreadable version is
      // neither of the determinate states.
      expect(piRow(out)).not.toContain('up to date');
      expect(piRow(out)).not.toContain('update');
    });

    it('--status --json carries a null version and an unknown action', () => {
      const { out } = run(['--status', '--json'], { home, path: `${PI_STUB_DIR}:${CORE_PATH}` });
      const pi = JSON.parse(out).agents.find((a: { agent: string }) => a.agent === 'pi');
      expect(pi.present).toBe(true);
      expect(pi.installed).toBeNull(); // a semver or null, never a marker string
      expect(pi.action).toBe('unknown');
    });
  });

  describe('update-all', () => {
    it('skips an unknown row with unknown as the reason, exits 0, and runs nothing', () => {
      const { code, out } = run(['--action=update', '--yes'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
      });
      expect(code).toBe(0);
      expect(out).toContain('pi: version unknown — skipped');
      // Unattended: reinstalling on ignorance would act on every single run.
      expect(out).not.toContain('RAN:pi');
    });

    it('control — the same command DOES update it when the version is readable and old', () => {
      const agentDir = join(home, 'piagent');
      installedFixture(agentDir, '0.0.1');
      const { code, out } = run(['--action=update', '--yes'], {
        home,
        path: `${PI_STUB_DIR}:${CORE_PATH}`,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      expect(code).toBe(0);
      expect(out).toContain('RAN:pi install npm:@rembric/pi');
      expect(out).not.toContain('pi: version unknown');
    });
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
      join(home, '.config', 'rembric', 'bin', 'rembric-plugin-core.mjs'),
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

  it.each([
    { label: 'core', good: 'rembric-dotenv.mjs', drifted: 'rembric-plugin-core.mjs' },
    { label: 'dotenv', good: 'rembric-plugin-core.mjs', drifted: 'rembric-dotenv.mjs' },
  ])('a drifted $label import aborts even though the other rewrite succeeded', ({ drifted }) => {
    const drift = mkdtempSync(join(tmpdir(), 'rembric-drift-'));
    writeFileSync(
      join(drift, 'plugin.ts'),
      [
        '// @rembric-plugin-version 0.0.0',
        "import { readRembricSlug } from '../bin/rembric-dotenv.mjs';",
        "import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';",
        'export const RembricPlugin = () => ({});',
        '',
      ]
        .join('\n')
        // Drift ONE import out of the sed pattern's reach; the other still rewrites.
        .replace(`../bin/${drifted}`, `./lib/${drifted}`),
    );
    const { code, out } = run([], {
      home,
      script: OPENCODE_INSTALL,
      env: { PLUGIN_SRC: drift, BIN_SRC: join(REPO_ROOT, 'apps', 'plugin', 'bin') },
    });
    rmSync(drift, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(out).toContain('rewrite failed');
    expect(out).toContain(drifted);
    expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'rembric.ts'))).toBe(false);
  });

  it('the installed plugin loads, resolving both shared modules from disk', async () => {
    const ins = run(['--agent=opencode', '--action=install'], { home });
    expect(ins.code).toBe(0);

    const installed = join(home, '.config', 'opencode', 'plugins', 'rembric.ts');
    const mod = (await import(installed)) as Record<string, unknown>;
    expect(typeof mod.RembricPlugin).toBe('function');
    // Control: only the plugin function is exported. opencode invokes EVERY
    // named export with the plugin ctx, so a leaked helper crashes on load.
    expect(Object.keys(mod)).toEqual(['RembricPlugin']);
  });

  it('every file the install copies is removed by the uninstall', () => {
    const filesUnder = (root: string): string[] => {
      const walk = (rel: string): string[] =>
        readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(rel, e.name)) : [join(rel, e.name)],
        );
      return walk('.').sort();
    };

    expect(run(['--agent=opencode', '--action=install'], { home }).code).toBe(0);
    const installedFiles = filesUnder(home);
    expect(installedFiles).toContain('.config/rembric/bin/rembric-plugin-core.mjs');

    expect(run(['--agent=opencode', '--action=uninstall'], { home }).code).toBe(0);
    // opencode.json is the one documented exception — the uninstaller prints
    // the mcp.rembric block for the operator to remove by hand rather than
    // editing a file that may configure other MCP servers.
    expect(filesUnder(home)).toEqual(['.config/opencode/opencode.json']);
  });
});

describe('--yes runs the marketplace command (stubbed client binary)', () => {
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
    expect(data.agents.map((d) => d.agent)).toEqual(CLIENTS);
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
    statUid?: string,
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
    // When provided, stub `stat` to report this owning uid — lets a test
    // simulate an already-10001-owned ./data without needing root to
    // actually chown it (CI runs non-root). Ignores args so both the GNU
    // `stat -c '%u'` and BSD `stat -f '%u'` forms return it.
    if (statUid !== undefined) {
      writeFileSync(join(d, 'stat'), `#!/bin/sh\necho ${statUid}\nexit 0\n`);
      chmodSync(join(d, 'stat'), 0o755);
    }
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
    // already-working install to world-writable. `stat` is stubbed to report
    // uid 10001 (we can't really chown to 10001 without root, and CI runs
    // non-root), so this exercises the installer's decision, not the syscall.
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { mode: 0o750 });
    const bin = fakeDockerDir('ok', 'healthy', 'fail', '10001');
    const { code, out } = run(['--server', '--action=install', '--up'], {
      cwd: dir,
      path: `${bin}:${process.env.PATH}`,
    });
    rmSync(bin, { recursive: true, force: true });
    expect(code).toBe(0);
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
