import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { parseDotenv, SLUG_RE } from './rembric-dotenv.mjs';

export const FINGERPRINT_HEADER = 'X-Rembric-Repo-Fingerprint';
export const RESOLVE_TIMEOUT_MS = 2000;
const GIT_TIMEOUT_MS = 2000;
const FINGERPRINT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTES_MAX = 8;
const REMOTE_MAX_CHARS = 512;
const ROOT_NAME_MAX_CHARS = 255;
const UNBOUND_REASONS = new Set(['not_bound', 'unknown_remote', 'no_fingerprint']);
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];

function gitEnv() {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  return env;
}

function runGit(cwd, args) {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, env: gitEnv() }, (error, stdout) =>
      done(
        error
          ? { ok: false, missing: error.code === 'ENOENT', out: '' }
          : { ok: true, out: String(stdout).trim() },
      ),
    );
  });
}

function realDirectory(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return resolve(directory);
  }
}

function dotGitAncestor(directory) {
  for (let dir = realDirectory(directory); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export function normalizeRemote(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    if (scheme[1].toLowerCase() === 'file') return null;
    value = value.slice(scheme[0].length);
    value = value.slice(value.lastIndexOf('@') + 1).replace(/[?#].*$/, '');
    const slash = value.indexOf('/');
    const authority = slash === -1 ? value : value.slice(0, slash);
    const path = slash === -1 ? '' : value.slice(slash);
    value = `${authority.replace(/:\d*$/, '')}${path}`;
  } else {
    value = value.slice(value.lastIndexOf('@') + 1);
    const scp = /^([^:/\\]+):(?!\/\/)(.*)$/.exec(value);
    if (!scp || scp[1].length < 2) return null;
    value = `${scp[1]}/${scp[2].replace(/[?#].*$/, '')}`;
  }
  if (value.startsWith('/') || value.includes('\\')) return null;
  value = value
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!value || value.length > REMOTE_MAX_CHARS) return null;
  return value;
}

export async function inspectRepository(startDir) {
  const inside = await runGit(startDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok && inside.missing) {
    const root = dotGitAncestor(startDir);
    return root
      ? { insideGit: true, root, fingerprint: null, cause: 'git_unavailable', remotes: [] }
      : { insideGit: false };
  }
  if (!inside.ok || inside.out !== 'true') return { insideGit: false };

  const toplevel = await runGit(startDir, ['rev-parse', '--show-toplevel']);
  const root = toplevel.ok && toplevel.out ? realDirectory(toplevel.out) : realDirectory(startDir);
  const repository = { insideGit: true, root, fingerprint: null, cause: null, remotes: [] };

  const shallow = await runGit(startDir, ['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok || shallow.out !== 'false') {
    repository.cause = shallow.ok && shallow.out === 'true' ? 'shallow' : 'git_unavailable';
    return repository;
  }

  const rootCommit = await runGit(startDir, [
    'rev-list',
    '--first-parent',
    '--max-parents=0',
    'HEAD',
  ]);
  if (!rootCommit.ok) {
    const head = await runGit(startDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    repository.cause = head.ok ? 'git_unavailable' : 'no_commit';
    return repository;
  }
  if (!FINGERPRINT_RE.test(rootCommit.out)) {
    repository.cause = 'git_unavailable';
    return repository;
  }
  repository.fingerprint = rootCommit.out;

  const names = await runGit(startDir, ['remote']);
  const remotes = [];
  for (const name of names.ok ? names.out.split('\n').filter(Boolean) : []) {
    const url = await runGit(startDir, ['remote', 'get-url', name]);
    const normalized = url.ok ? normalizeRemote(url.out) : null;
    if (normalized && !remotes.includes(normalized)) remotes.push(normalized);
    if (remotes.length >= REMOTES_MAX) break;
  }
  repository.remotes = remotes;
  return repository;
}

function readCandidate(file, displayFile) {
  try {
    const parsed = parseDotenv(readFileSync(file, 'utf8'));
    if (!parsed.PROJECT_SLUG) return { slug: null, issue: `${displayFile} has no PROJECT_SLUG` };
    if (!SLUG_RE.test(parsed.PROJECT_SLUG)) {
      return {
        slug: null,
        issue: `PROJECT_SLUG="${parsed.PROJECT_SLUG}" in ${displayFile} is invalid`,
      };
    }
    return { slug: parsed.PROJECT_SLUG, issue: null };
  } catch {
    return { slug: null, issue: `Could not read ${displayFile}` };
  }
}

function findRembric(projectDir, checkoutRoot) {
  if (!checkoutRoot) {
    const file = join(projectDir, '.rembric');
    if (!existsSync(file))
      return { slug: null, issue: `No .rembric in ${projectDir}`, source: null };
    return { ...readCandidate(file, file), source: 'rembric' };
  }
  const start = realDirectory(projectDir);
  const within = start === checkoutRoot || start.startsWith(`${checkoutRoot}${sep}`);
  for (let dir = start; ; dir = dirname(dir)) {
    const file = join(dir, '.rembric');
    if (existsSync(file)) {
      return {
        ...readCandidate(file, file),
        source: dir === checkoutRoot ? 'rembric-root' : 'rembric-nested',
      };
    }
    if (!within || dir === checkoutRoot || dirname(dir) === dir) break;
  }
  return {
    slug: null,
    issue: `No .rembric in ${projectDir} or its parents up to the checkout root ${checkoutRoot}`,
    source: null,
  };
}

export function resolveSlug(projectDir, env = process.env, checkoutRoot = null) {
  const environmentSlug = env.REMBRIC_PROJECT_SLUG;
  const found = findRembric(projectDir, checkoutRoot);
  if (found.slug) return { slug: found.slug, source: found.source, issue: null };
  if (environmentSlug && SLUG_RE.test(environmentSlug)) {
    return { slug: environmentSlug, source: 'env', issue: found.issue };
  }
  if (environmentSlug) {
    return {
      slug: null,
      source: null,
      issue: `${environmentSlug} in REMBRIC_PROJECT_SLUG is invalid`,
    };
  }
  return { slug: null, source: null, issue: found.issue };
}

export function buildEndpoint(baseUrl, slug) {
  return `${baseUrl.replace(/\/+$/, '')}/mcp${slug ? `/${slug}` : ''}`;
}

async function postResolve({ serverUrl, apiToken, body, fetchImpl, timeoutMs }) {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/repositories/resolve`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { failure: timedOut ? 'timeout' : 'network' };
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 409 && payload?.code === 'repository_ambiguous') {
    const slugs = Array.isArray(payload.slugs) ? payload.slugs.filter((s) => SLUG_RE.test(s)) : [];
    return { failure: 'ambiguous', slugs };
  }
  if (!response.ok) return { failure: 'status', status: response.status };
  if (!payload || payload.ok !== true) return { failure: 'invalid_response' };
  return { answer: payload };
}

function fingerprintLabel(repository) {
  return repository.fingerprint ? repository.fingerprint.slice(0, 12) : 'without fingerprint';
}

const NO_FINGERPRINT_REMEDY = {
  shallow:
    'it is a shallow clone, so its history has no reliable root; fetch the full history (git fetch --unshallow) or add a .rembric file containing PROJECT_SLUG=<slug>',
  no_commit:
    'it has no commit yet; make a first commit or add a .rembric file containing PROJECT_SLUG=<slug>',
  git_unavailable:
    'git could not read its history; make git available or add a .rembric file containing PROJECT_SLUG=<slug>',
};

function unboundMessage(repository, reason) {
  if (!repository.fingerprint) {
    return (
      `This git repository has no fingerprint (${NO_FINGERPRINT_REMEDY[repository.cause ?? 'git_unavailable']}); ` +
      'Rembric memory is off for this session.'
    );
  }
  const why =
    reason === 'unknown_remote'
      ? 'its remotes do not match the project bound to its history'
      : 'it is not bound to a project';
  return (
    `This repository (${fingerprintLabel(repository)}) has no Rembric project: ${why}. ` +
    'Memory is off for this session. Sessions here used the default project before this version; ' +
    'binding the repository to the default project keeps that continuity. Ask an admin to bind it ' +
    'from the dashboard, or add a .rembric file containing PROJECT_SLUG=<slug>. A binding applies ' +
    'from the next session.'
  );
}

function refusedMessage(serverUrl, result, timeoutMs) {
  const remedy =
    'update the Rembric server, or add a .rembric file containing PROJECT_SLUG=<slug> to the checkout. ' +
    'Not connecting, so nothing lands in the default project.';
  switch (result.failure) {
    case 'ambiguous':
      return (
        `This repository is bound to several projects you can access (${result.slugs.join(', ')}); ` +
        'add a .rembric file containing PROJECT_SLUG=<slug> naming one of them. Not connecting.'
      );
    case 'no_credentials':
      return 'REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing, so this repository cannot be resolved to a project. Not connecting.';
    case 'timeout':
      return `${serverUrl} did not answer POST /api/repositories/resolve within ${timeoutMs} ms; ${remedy}`;
    case 'network':
      return `${serverUrl} could not be reached for POST /api/repositories/resolve; ${remedy}`;
    case 'status':
      return `${serverUrl} answered POST /api/repositories/resolve with HTTP ${result.status}, so it does not support repository fingerprints; ${remedy}`;
    default:
      return `${serverUrl} answered POST /api/repositories/resolve with an unexpected body; ${remedy}`;
  }
}

function conflictMessage(slug, source, boundSlugs) {
  const from = source === 'env' ? 'REMBRIC_PROJECT_SLUG' : '.rembric';
  return (
    `${from} selects project '${slug}', but this repository is bound to ` +
    `${boundSlugs.map((s) => `'${s}'`).join(', ')}; using '${slug}'.`
  );
}

function resolveTimeout(env, timeoutMs) {
  if (timeoutMs !== undefined) return timeoutMs;
  const configured = Number(env.REMBRIC_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : RESOLVE_TIMEOUT_MS;
}

export async function resolveProject({
  startDir,
  env = process.env,
  serverUrl,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs,
}) {
  const budget = resolveTimeout(env, timeoutMs);
  const repository = await inspectRepository(startDir);

  if (!repository.insideGit) {
    const selected = resolveSlug(startDir, env, null);
    return {
      mode: selected.slug ? 'project' : 'default',
      slug: selected.slug,
      source: selected.source,
      issue: selected.issue,
      repository: null,
      header: null,
      conflict: null,
      reason: null,
      message: null,
    };
  }

  const selected = resolveSlug(startDir, env, repository.root);
  const header = repository.fingerprint ?? 'unavailable';
  const base = {
    slug: selected.slug,
    source: selected.slug ? selected.source : null,
    issue: selected.issue,
    repository,
    header,
    conflict: null,
    reason: null,
    message: null,
  };
  const credentials = Boolean(serverUrl && apiToken);

  if (selected.slug) {
    if (!repository.fingerprint || !credentials) return { ...base, mode: 'project' };
    const result = await postResolve({
      serverUrl,
      apiToken,
      fetchImpl,
      timeoutMs: budget,
      body: {
        fingerprint: repository.fingerprint,
        remotes: repository.remotes,
        ...rootNameField(repository),
        explicit: { slug: selected.slug, source: selected.source },
      },
    });
    const boundSlugs = result.answer?.conflict?.boundSlugs;
    if (result.answer?.outcome === 'explicit' && Array.isArray(boundSlugs) && boundSlugs.length) {
      const conflict = { boundSlugs: boundSlugs.filter((s) => SLUG_RE.test(s)) };
      return {
        ...base,
        mode: 'project',
        conflict,
        message: conflictMessage(selected.slug, selected.source, conflict.boundSlugs),
      };
    }
    return { ...base, mode: 'project' };
  }

  if (!credentials) {
    const failure = { failure: 'no_credentials' };
    return {
      ...base,
      mode: 'refused',
      reason: 'no_credentials',
      message: refusedMessage(serverUrl, failure, budget),
    };
  }

  const result = await postResolve({
    serverUrl,
    apiToken,
    fetchImpl,
    timeoutMs: budget,
    body: {
      fingerprint: repository.fingerprint,
      remotes: repository.fingerprint ? repository.remotes : [],
      ...rootNameField(repository),
    },
  });
  const answer = result.answer;
  if (answer?.outcome === 'bound' && typeof answer.slug === 'string' && SLUG_RE.test(answer.slug)) {
    return { ...base, mode: 'project', slug: answer.slug, source: 'fingerprint' };
  }
  if (answer?.outcome === 'unbound') {
    const reason = UNBOUND_REASONS.has(answer.reason) ? answer.reason : 'not_bound';
    return { ...base, mode: 'unbound', reason, message: unboundMessage(repository, reason) };
  }
  const failure = answer ? { failure: 'invalid_response' } : result;
  return {
    ...base,
    mode: 'refused',
    reason: failure.failure === 'status' ? `http_${failure.status}` : failure.failure,
    ambiguous: failure.failure === 'ambiguous' ? failure.slugs : undefined,
    message: refusedMessage(serverUrl, failure, budget),
  };
}

function rootNameField(repository) {
  if (!repository.fingerprint || repository.remotes.length > 0) return {};
  const name = basename(repository.root);
  return name && name.length <= ROOT_NAME_MAX_CHARS && !/[/\\]/.test(name)
    ? { rootName: name }
    : {};
}
