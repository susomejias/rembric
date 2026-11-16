import type { RepositoryPending } from '@rembric/db';

import type {
  BoundRepository,
  PendingRepository,
  ProjectRef,
  ProjectRepositories,
} from '@/components/dashboard/repositories-section';
import type { Services } from '@/lib/services';

const PREFIX_LENGTH = 12;

export interface RepositoryData {
  readonly live: PendingRepository[];
  readonly discarded: PendingRepository[];
  forProject(projectId: string): ProjectRepositories;
}

export function loadRepositoryData(
  services: Pick<Services, 'repos' | 'tokens' | 'repositoryBindings'>,
  projects: readonly ProjectRef[],
): RepositoryData {
  const { repos, tokens, repositoryBindings } = services;
  const slugs = new Map(projects.map((p) => [p.id, p.slug]));
  const ref = (id: string): ProjectRef => ({ id, slug: slugs.get(id) ?? id });

  const bindings = repos.repositoryBindings.adminListAll();
  const byFingerprint = new Map<string, typeof bindings>();
  for (const binding of bindings) {
    byFingerprint.set(binding.fingerprint, [
      ...(byFingerprint.get(binding.fingerprint) ?? []),
      binding,
    ]);
  }

  const liveRows = repos.pendingRepositories.adminListLive(repositoryBindings.pendingCutoff());
  const discardedRows = repos.pendingRepositories.adminListDiscarded();
  const tokenNames = new Map<string, string[]>();
  for (const view of repos.pendingRepositories.adminListTokens(
    [...liveRows, ...discardedRows].map((row) => row.id),
  )) {
    tokenNames.set(view.pendingId, [
      ...(tokenNames.get(view.pendingId) ?? []),
      view.tokenName ?? 'deleted token',
    ]);
  }

  const toPending = (row: RepositoryPending): PendingRepository => {
    const rowBindings = byFingerprint.get(row.fingerprint) ?? [];
    const known =
      row.kind === 'unknown_remote'
        ? (rowBindings.find((b) => b.projectId === row.projectId)?.remotes ?? [])
        : [];
    return {
      id: row.id,
      kind: row.kind,
      fingerprint: row.fingerprint,
      fingerprintPrefix: row.fingerprint.slice(0, PREFIX_LENGTH),
      remotes: row.remotes,
      rootName: row.rootName,
      project: row.projectId === null ? null : ref(row.projectId),
      unseenRemotes: row.remotes.filter((remote) => !known.includes(remote)),
      bindings: rowBindings.map((b) => ref(b.projectId)),
      tokens: tokenNames.get(row.id) ?? [],
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      discardedAt: row.discardedAt,
    };
  };
  const live = liveRows.map(toPending);
  const discarded = discardedRows.map(toPending);

  const creators = new Map<string, string>();
  const creatorLabel = (createdBy: string): string => {
    const cached = creators.get(createdBy);
    if (cached !== undefined) return cached;
    const [kind, id] = createdBy.split(':', 2);
    const name = id === undefined ? undefined : tokens.findById(id)?.name;
    const label =
      name === undefined ? createdBy : kind === 'dashboard' ? `${name} (dashboard)` : name;
    creators.set(createdBy, label);
    return label;
  };

  return {
    live,
    discarded,
    forProject(projectId) {
      const bound: BoundRepository[] = bindings
        .filter((b) => b.projectId === projectId)
        .map((b) => ({
          fingerprint: b.fingerprint,
          fingerprintPrefix: b.fingerprint.slice(0, PREFIX_LENGTH),
          remotes: b.remotes,
          createdAt: b.createdAt,
          createdBy: creatorLabel(b.createdBy),
        }));
      const naming = live.filter((row) => row.kind !== 'unbound' && row.project?.id === projectId);
      const unbound = live.filter((row) => row.kind === 'unbound');
      const conflicts = live.filter(
        (row) =>
          row.kind === 'suggestion' &&
          row.project?.id !== projectId &&
          row.bindings.some((b) => b.id === projectId),
      );
      return { bound, pending: [...naming, ...unbound], conflicts };
    },
  };
}
