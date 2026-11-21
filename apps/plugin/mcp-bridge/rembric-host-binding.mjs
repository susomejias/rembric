import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const HOST_SESSION_HEADER = 'X-Rembric-Session';
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const HOST_SESSIONS_DIR = ['.cache', 'rembric', 'host-sessions'];
export const HOST_SESSIONS_DIR_MODE = 0o700;
export const HOST_BINDING_FILE_MODE = 0o600;
export const HOST_BINDING_KEYS = ['pid', 'start', 'sessionId'];
export const START_LOCALE = 'C';
export const MAX_ANCESTORS = 8;
export const NON_HOST_COMMANDS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env'];
export const LAUNCHER_COMMANDS = ['npm', 'npx'];

const LAUNCHER_NAMES = new Set([...NON_HOST_COMMANDS, ...LAUNCHER_COMMANDS]);
const NPM_LAUNCHER_ARGS = [/^(\S*\/)?np[mx](\s|$)/, /^(\S*\/)?node\s+(\S*\/)?np[mx]-cli\.js(\s|$)/];

const PS_TIMEOUT_MS = 2000;

export function startTokenArgs(pid) {
  return ['-o', 'lstart=', '-p', String(pid)];
}

export function runPs(args) {
  try {
    return execFileSync('ps', args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: START_LOCALE },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

export function processStartToken(pid, { run = runPs } = {}) {
  const output = run(startTokenArgs(pid));
  if (typeof output !== 'string') return null;
  const token = output.replace(/\s+/g, ' ').trim();
  return token || null;
}

function parentPid(pid, run) {
  const output = run(['-o', 'ppid=', '-p', String(pid)]);
  const parent = Number(typeof output === 'string' ? output.trim() : '');
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

function psField(pid, field, run) {
  const output = run(['-o', `${field}=`, '-p', String(pid)]);
  return typeof output === 'string' ? output.trim() : '';
}

export function isLauncher({ comm = '', args = '' }) {
  const name = basename(comm.trim()).replace(/^-/, '');
  if (LAUNCHER_NAMES.has(name)) return true;
  const line = args.trim();
  return NPM_LAUNCHER_ARGS.some((pattern) => pattern.test(line));
}

export function ancestorChain({
  ppid = process.ppid,
  run = runPs,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') return [];
  const chain = [];
  let pid = ppid;
  for (let visited = 0; visited < MAX_ANCESTORS && pid > 1; visited += 1) {
    const entry = { comm: psField(pid, 'comm', run), args: psField(pid, 'args', run) };
    if (!isLauncher(entry)) {
      chain.push({ pid, start: processStartToken(pid, { run }), launcher: false });
      break;
    }
    chain.push({ pid, launcher: true });
    const parent = parentPid(pid, run);
    if (parent === null || parent === pid) break;
    pid = parent;
  }
  return chain;
}

export function hostSessionsDir(home = homedir()) {
  return join(home, ...HOST_SESSIONS_DIR);
}

export function hostBindingPath(pid, home = homedir()) {
  return join(hostSessionsDir(home), `${pid}.json`);
}

function readBinding(pid, home) {
  try {
    const parsed = JSON.parse(readFileSync(hostBindingPath(pid, home), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function lookupHostSession(chain, { home, platform = process.platform } = {}) {
  if (platform === 'win32') return null;
  try {
    const host = chain.find((entry) => !entry.launcher);
    if (!host || typeof host.start !== 'string') return null;
    const binding = readBinding(host.pid, home ?? homedir());
    if (
      binding &&
      binding.pid === host.pid &&
      binding.start === host.start &&
      typeof binding.sessionId === 'string' &&
      SESSION_ID_RE.test(binding.sessionId)
    ) {
      return binding.sessionId;
    }
  } catch {
    return null;
  }
  return null;
}

export function publishHostBinding({
  pid = process.pid,
  sessionId,
  start,
  home,
  platform = process.platform,
  run = runPs,
} = {}) {
  if (platform === 'win32') return false;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
  let temporary = null;
  try {
    const token = start ?? processStartToken(pid, { run });
    if (!token) return false;
    const root = home ?? homedir();
    const dir = hostSessionsDir(root);
    mkdirSync(dir, { recursive: true, mode: HOST_SESSIONS_DIR_MODE });
    chmodSync(dir, HOST_SESSIONS_DIR_MODE);
    temporary = join(dir, `.${pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temporary, JSON.stringify({ pid, start: token, sessionId }), {
      mode: HOST_BINDING_FILE_MODE,
      flag: 'wx',
    });
    renameSync(temporary, hostBindingPath(pid, root));
    return true;
  } catch {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // Already renamed or never created.
      }
    }
    return false;
  }
}

export function removeHostBinding({
  pid = process.pid,
  sessionId,
  home,
  platform = process.platform,
} = {}) {
  if (platform === 'win32' || typeof sessionId !== 'string') return false;
  try {
    const root = home ?? homedir();
    if (readBinding(pid, root)?.sessionId !== sessionId) return false;
    unlinkSync(hostBindingPath(pid, root));
    return true;
  } catch {
    return false;
  }
}
