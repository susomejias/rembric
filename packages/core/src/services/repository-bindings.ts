import {
  type ProjectRepository,
  type Repositories,
  type RepositoryBindingView,
  type RepositoryPendingKind,
  type TransactionRunner,
} from '@rembric/db';
import { ulid } from 'ulid';

import { DomainError } from './errors.js';
import { isAuthorized, type TokenReach, type TokenScope } from './tokens.js';

export const REPOSITORY_FINGERPRINT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const EXPLICIT_SELECTION_SOURCES = ['rembric-root', 'rembric-nested', 'env'] as const;
export type ExplicitSelectionSource = (typeof EXPLICIT_SELECTION_SOURCES)[number];

export const DEFAULT_REPO_PENDING_TTL_DAYS = 14;
export const DEFAULT_REPO_PENDING_MAX_PER_TOKEN = 20;
const MAX_STORED_REMOTES = 32;
const DAY_MS = 86_400_000;

export interface RepositoryResolveInput {
  fingerprint: string | null;
  remotes: readonly string[];
  rootName?: string | null;
  explicit?: { slug: string; source: ExplicitSelectionSource } | null;
}

export type RepositoryResolution =
  | { outcome: 'bound'; slug: string }
  | { outcome: 'unbound'; reason: 'not_bound' | 'unknown_remote' | 'no_fingerprint' }
  | { outcome: 'explicit'; slug: string; conflict: { boundSlugs: string[] } | null }
  | { outcome: 'ambiguous'; slugs: string[] };

export interface RepositoryActor extends TokenReach {
  tokenId: string;
}

export interface RepositoryBindingsOptions {
  pendingTtlDays?: number;
  pendingMaxPerToken?: number;
  now?: () => Date;
}

type BindingRepos = Pick<Repositories, 'projects' | 'repositoryBindings' | 'pendingRepositories'>;

export function normalizeRemote(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.includes('\\')) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(value);
  let host: string;
  let path: string;
  if (scheme) {
    const rest = value.slice(scheme[0].length);
    const afterUser = rest.slice(rest.lastIndexOf('@') + 1);
    const slash = afterUser.indexOf('/');
    host = (slash === -1 ? afterUser : afterUser.slice(0, slash)).replace(/:\d*$/, '');
    path = slash === -1 ? '' : afterUser.slice(slash + 1);
  } else {
    const rest = value.slice(value.lastIndexOf('@') + 1);
    const colon = rest.indexOf(':');
    const slash = rest.indexOf('/');
    if (colon !== -1 && (slash === -1 || colon < slash)) {
      host = rest.slice(0, colon);
      path = rest.slice(colon + 1);
      if (host.length < 2) return null;
    } else {
      if (slash === -1) return null;
      host = rest.slice(0, slash);
      path = rest.slice(slash + 1);
    }
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/.test(host)) return null;
  const segments = path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((s) => s.length > 0);
  const last = segments.length - 1;
  if (last >= 0 && segments[last]!.endsWith('.git')) segments[last] = segments[last]!.slice(0, -4);
  const cleaned = segments.filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;
  return `${host}/${cleaned.join('/')}`;
}

export function normalizeRemotes(raw: readonly string[]): string[] {
  return mergeRemotes(
    [],
    raw.map(normalizeRemote).filter((r): r is string => r !== null),
  );
}

function mergeRemotes(known: readonly string[], added: readonly string[]): string[] {
  const merged = [...known];
  for (const remote of [...new Set(added)].sort()) {
    if (merged.length >= MAX_STORED_REMOTES) break;
    if (!merged.includes(remote)) merged.push(remote);
  }
  return merged.sort();
}

function scopeAuthorizesWriting(scope: TokenScope): boolean {
  return scope === '*' || scope === 'projects' || scope.startsWith('project:');
}

export class RepositoryBindingsService {
  private readonly ttlMs: number;
  private readonly maxPerToken: number;
  private readonly now: () => Date;

  constructor(
    private readonly repos: BindingRepos,
    private readonly tx: TransactionRunner,
    opts: RepositoryBindingsOptions = {},
  ) {
    this.ttlMs = (opts.pendingTtlDays ?? DEFAULT_REPO_PENDING_TTL_DAYS) * DAY_MS;
    this.maxPerToken = opts.pendingMaxPerToken ?? DEFAULT_REPO_PENDING_MAX_PER_TOKEN;
    this.now = opts.now ?? (() => new Date());
  }

  visibleBindings(reach: TokenReach, fingerprint: string): RepositoryBindingView[] {
    const readable = this.repos.projects
      .listOrdered(true)
      .filter((p) => isAuthorized(reach, 'read', { scope: 'project', projectId: p.id }))
      .map((p) => p.id);
    return this.repos.repositoryBindings.listForFingerprint(fingerprint, readable);
  }

  resolve(actor: RepositoryActor, input: RepositoryResolveInput): RepositoryResolution {
    return this.tx.transaction(() => this.resolveInTx(actor, input));
  }

  private resolveInTx(actor: RepositoryActor, input: RepositoryResolveInput): RepositoryResolution {
    const { fingerprint, explicit } = input;
    if (fingerprint === null) {
      return explicit
        ? { outcome: 'explicit', slug: explicit.slug, conflict: null }
        : { outcome: 'unbound', reason: 'no_fingerprint' };
    }
    const remotes = normalizeRemotes(input.remotes);
    const sighting = { fingerprint, remotes, rootName: input.rootName ?? null };
    const record = scopeAuthorizesWriting(actor.scope);
    const visible = this.visibleBindings(actor, fingerprint);

    if (explicit) {
      const boundSlugs = visible.map((b) => b.slug);
      if (record && explicit.source === 'rembric-root' && !boundSlugs.includes(explicit.slug)) {
        const project = this.repos.projects.findBySlug(explicit.slug);
        if (project && isAuthorized(actor, 'write', { scope: 'project', projectId: project.id })) {
          this.recordSighting(actor, sighting, 'suggestion', project.id);
        }
      }
      const conflict =
        boundSlugs.length > 0 && !boundSlugs.includes(explicit.slug) ? { boundSlugs } : null;
      return { outcome: 'explicit', slug: explicit.slug, conflict };
    }

    if (visible.length > 1) return { outcome: 'ambiguous', slugs: visible.map((b) => b.slug) };
    const binding = visible[0];
    if (!binding) {
      if (record) this.recordSighting(actor, sighting, 'unbound', null);
      return { outcome: 'unbound', reason: 'not_bound' };
    }
    const known = binding.remotes;
    if (known.length > 0 && remotes.length > 0 && !remotes.some((r) => known.includes(r))) {
      if (record) this.recordSighting(actor, sighting, 'unknown_remote', binding.projectId);
      return { outcome: 'unbound', reason: 'unknown_remote' };
    }
    if (remotes.some((r) => !known.includes(r))) {
      this.repos.repositoryBindings.updateRemotes(
        fingerprint,
        binding.projectId,
        mergeRemotes(known, remotes),
      );
    }
    return { outcome: 'bound', slug: binding.slug };
  }

  private recordSighting(
    actor: RepositoryActor,
    sighting: { fingerprint: string; remotes: string[]; rootName: string | null },
    kind: RepositoryPendingKind,
    projectId: string | null,
  ): void {
    const pending = this.repos.pendingRepositories;
    const now = this.now();
    const cutoff = new Date(now.getTime() - this.ttlMs);
    let row = pending.findByIdentity(sighting.fingerprint, kind, projectId);
    if (row && row.discardedAt === null && row.lastSeenAt < cutoff) {
      pending.delete(row.id);
      row = undefined;
    }
    if (row) {
      const remotes = mergeRemotes(row.remotes, sighting.remotes);
      pending.update(row.id, {
        lastSeenAt: now,
        remotes,
        rootName: remotes.length > 0 ? null : (sighting.rootName ?? row.rootName),
      });
      pending.linkToken(row.id, actor.tokenId);
      return;
    }
    if (pending.countLiveForToken(actor.tokenId, cutoff) >= this.maxPerToken) return;
    const created = pending.insert({
      id: ulid(now.getTime()),
      fingerprint: sighting.fingerprint,
      kind,
      projectId,
      remotes: sighting.remotes,
      rootName: sighting.remotes.length > 0 ? null : sighting.rootName,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    pending.linkToken(created.id, actor.tokenId);
  }

  bindUnbound(input: { fingerprint: string; slug: string; createdBy: string }): {
    slug: string;
    fingerprint: string;
  } {
    return this.tx.transaction(() => {
      const project = this.repos.projects.findBySlug(input.slug);
      if (!project) {
        throw new DomainError(
          'project_not_found',
          `project '${input.slug}' does not exist; create it from the dashboard`,
        );
      }
      if (project.archivedAt) {
        throw new DomainError(
          'project_archived',
          `project '${project.slug}' is archived; new writes are rejected`,
        );
      }
      const existing = this.repos.repositoryBindings.unsafeListAllForFingerprint(input.fingerprint);
      if (existing.length > 0) {
        const boundSlugs = existing.map((b) => b.slug);
        throw new DomainError(
          'repository_already_bound',
          `this repository is already bound to ${boundSlugs.map((s) => `'${s}'`).join(', ')}; ` +
            'moving or removing a binding is done from the dashboard',
          { boundSlugs },
        );
      }
      this.insertBinding(input.fingerprint, project.id, input.createdBy);
      return { slug: project.slug, fingerprint: input.fingerprint };
    });
  }

  bind(input: { fingerprint: string; projectId: string; createdBy: string }): ProjectRepository {
    if (!REPOSITORY_FINGERPRINT_RE.test(input.fingerprint)) {
      throw new DomainError(
        'invalid_repository_fingerprint',
        'a repository fingerprint is 40 or 64 lowercase hexadecimal characters',
      );
    }
    return this.tx.transaction(() => {
      const project = this.repos.projects.findById(input.projectId);
      if (!project) {
        throw new DomainError('project_not_found', `project id=${input.projectId} does not exist`);
      }
      if (project.archivedAt) {
        throw new DomainError('project_archived', `project '${project.slug}' is archived`);
      }
      return this.insertBinding(input.fingerprint, project.id, input.createdBy);
    });
  }

  move(input: {
    fingerprint: string;
    fromProjectId: string;
    toProjectId: string;
    createdBy: string;
  }): ProjectRepository {
    return this.tx.transaction(() => {
      const source = this.repos.repositoryBindings
        .unsafeListAllForFingerprint(input.fingerprint)
        .find((b) => b.projectId === input.fromProjectId);
      if (!source) {
        throw new DomainError('conflict', 'no binding exists for this repository and project');
      }
      const target = this.bind({
        fingerprint: input.fingerprint,
        projectId: input.toProjectId,
        createdBy: input.createdBy,
      });
      this.repos.repositoryBindings.delete(input.fingerprint, input.fromProjectId);
      const remotes = mergeRemotes(target.remotes, source.remotes);
      this.repos.repositoryBindings.updateRemotes(input.fingerprint, input.toProjectId, remotes);
      return { ...target, remotes };
    });
  }

  pendingCutoff(): Date {
    return new Date(this.now().getTime() - this.ttlMs);
  }

  bindWithChoice(input: {
    projectId: string;
    createdBy: string;
    fingerprint?: string;
    pendingId?: string;
    choice?: 'add' | { moveFrom: string };
  }): ProjectRepository {
    return this.tx.transaction(() => {
      let fingerprint = input.fingerprint ?? '';
      if (input.pendingId !== undefined) {
        const row = this.repos.pendingRepositories.findById(input.pendingId);
        if (!row) throw new DomainError('conflict', 'this pending repository no longer exists');
        fingerprint = row.fingerprint;
      }
      const { choice, projectId, createdBy } = input;
      let bound: ProjectRepository;
      if (typeof choice === 'object') {
        bound = this.move({
          fingerprint,
          fromProjectId: choice.moveFrom,
          toProjectId: projectId,
          createdBy,
        });
      } else {
        const others = this.repos.repositoryBindings
          .unsafeListAllForFingerprint(fingerprint)
          .filter((b) => b.projectId !== projectId);
        if (others.length > 0 && choice !== 'add') {
          throw new DomainError(
            'repository_already_bound',
            `this repository is already bound to ${others.map((b) => `'${b.slug}'`).join(', ')}; ` +
              'choose whether to move that binding or add a second one',
            { boundProjects: others.map((b) => ({ id: b.projectId, slug: b.slug })) },
          );
        }
        bound = this.bind({ fingerprint, projectId, createdBy });
      }
      if (input.pendingId !== undefined) this.repos.pendingRepositories.delete(input.pendingId);
      return bound;
    });
  }

  remove(input: { fingerprint: string; projectId: string }): boolean {
    return this.repos.repositoryBindings.delete(input.fingerprint, input.projectId);
  }

  discard(pendingId: string): boolean {
    return this.repos.pendingRepositories.setDiscardedAt(pendingId, this.now());
  }

  restore(pendingId: string): boolean {
    return this.repos.pendingRepositories.setDiscardedAt(pendingId, null);
  }

  acceptRemotes(pendingId: string): boolean {
    return this.tx.transaction(() => {
      const row = this.repos.pendingRepositories.findById(pendingId);
      if (!row || row.kind !== 'unknown_remote' || row.projectId === null) return false;
      const binding = this.repos.repositoryBindings
        .unsafeListAllForFingerprint(row.fingerprint)
        .find((b) => b.projectId === row.projectId);
      if (!binding) return false;
      this.repos.repositoryBindings.updateRemotes(
        row.fingerprint,
        row.projectId,
        mergeRemotes(binding.remotes, row.remotes),
      );
      this.repos.pendingRepositories.delete(row.id);
      return true;
    });
  }

  private insertBinding(
    fingerprint: string,
    projectId: string,
    createdBy: string,
  ): ProjectRepository {
    const pending = this.repos.pendingRepositories.listForFingerprint(fingerprint);
    const remotes = mergeRemotes(
      [],
      pending.flatMap((p) => p.remotes),
    );
    const inserted = this.repos.repositoryBindings.insert({
      fingerprint,
      projectId,
      remotes,
      createdAt: this.now(),
      createdBy,
    });
    if (!inserted) {
      throw new DomainError(
        'repository_already_bound',
        'this repository is already bound to that project',
      );
    }
    for (const row of pending) {
      const resolved =
        row.kind === 'unbound' || (row.kind === 'suggestion' && row.projectId === projectId);
      if (resolved) this.repos.pendingRepositories.delete(row.id);
    }
    return inserted;
  }
}
