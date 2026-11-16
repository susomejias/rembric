import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { ensureProjectLexicalIndex } from '../project-lexical-index.js';
import { projects, type NewProject, type Project } from '../schema/projects.js';
import {
  projectRepositories,
  repositoryPending,
  repositoryPendingTokens,
  type NewProjectRepository,
  type NewRepositoryPending,
  type ProjectRepository,
  type RepositoryPending,
  type RepositoryPendingKind,
} from '../schema/repositories.js';
import { tokens } from '../schema/tokens.js';

export class ProjectsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewProject): Project | undefined {
    const row = this.db.insert(projects).values(values).returning().get();
    if (row) ensureProjectLexicalIndex(this.db.$client, row.id);
    return row;
  }

  findById(id: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  findBySlug(slug: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.slug, slug)).get();
  }

  /** The system default project. At most one row can match: `projects_is_default_uidx`. */
  findDefault(): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.isDefault, true)).get();
  }

  listOrdered(includeArchived: boolean): Project[] {
    const query = this.db.select().from(projects).orderBy(asc(projects.createdAt)).$dynamic();
    return includeArchived ? query.all() : query.where(isNull(projects.archivedAt)).all();
  }

  listArchived(): Project[] {
    return this.db
      .select()
      .from(projects)
      .where(isNotNull(projects.archivedAt))
      .orderBy(asc(projects.createdAt))
      .all();
  }

  count(): number {
    const row = this.db.select({ value: count() }).from(projects).get();
    return row?.value ?? 0;
  }

  listAllIds(): string[] {
    return this.db
      .select({ id: projects.id })
      .from(projects)
      .all()
      .map((r) => r.id);
  }

  listActiveIds(): string[] {
    return this.db
      .select({ id: projects.id })
      .from(projects)
      .where(isNull(projects.archivedAt))
      .all()
      .map((r) => r.id);
  }

  listArchivedIds(): string[] {
    return this.db
      .select({ id: projects.id })
      .from(projects)
      .where(isNotNull(projects.archivedAt))
      .all()
      .map((r) => r.id);
  }

  listActiveSlugs(): string[] {
    return this.db
      .select({ slug: projects.slug })
      .from(projects)
      .where(isNull(projects.archivedAt))
      .all()
      .map((r) => r.slug);
  }

  updateDisplayName(id: string, displayName: string): Project | undefined {
    return this.db
      .update(projects)
      .set({ displayName })
      .where(eq(projects.id, id))
      .returning()
      .get();
  }

  /** Set/clear `archived_at`; when `requireActive`, only flips a non-archived row. */
  setArchivedAt(id: string, archivedAt: Date | null, requireActive: boolean): Project | undefined {
    return this.db
      .update(projects)
      .set({ archivedAt })
      .where(
        requireActive ? and(eq(projects.id, id), isNull(projects.archivedAt)) : eq(projects.id, id),
      )
      .returning()
      .get();
  }

  // admin* — unscoped dashboard reads

  adminListAll(): Project[] {
    return this.db.select().from(projects).all();
  }

  adminFindById(id: string): Project | undefined {
    return this.findById(id);
  }

  adminCountArchived(): number {
    const row = this.db
      .select({ value: count() })
      .from(projects)
      .where(isNotNull(projects.archivedAt))
      .get();
    return row?.value ?? 0;
  }
}

export type RepositoryBindingView = ProjectRepository & Pick<Project, 'slug'>;

export interface PendingRepositoryTokenView {
  pendingId: string;
  tokenId: string;
  tokenName: string | null;
}

const bindingColumns = {
  fingerprint: projectRepositories.fingerprint,
  projectId: projectRepositories.projectId,
  remotes: projectRepositories.remotes,
  createdAt: projectRepositories.createdAt,
  createdBy: projectRepositories.createdBy,
  slug: projects.slug,
};

export class RepositoryBindingsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewProjectRepository): ProjectRepository | undefined {
    return this.db
      .insert(projectRepositories)
      .values(values)
      .onConflictDoNothing()
      .returning()
      .get();
  }

  listForFingerprint(
    fingerprint: string,
    readableProjectIds: readonly string[],
  ): RepositoryBindingView[] {
    if (readableProjectIds.length === 0) return [];
    return this.db
      .select(bindingColumns)
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(
        and(
          eq(projectRepositories.fingerprint, fingerprint),
          inArray(projectRepositories.projectId, [...readableProjectIds]),
        ),
      )
      .orderBy(asc(projects.slug))
      .all();
  }

  unsafeListAllForFingerprint(fingerprint: string): RepositoryBindingView[] {
    return this.db
      .select(bindingColumns)
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(eq(projectRepositories.fingerprint, fingerprint))
      .orderBy(asc(projects.slug))
      .all();
  }

  updateRemotes(fingerprint: string, projectId: string, remotes: string[]): void {
    this.db
      .update(projectRepositories)
      .set({ remotes })
      .where(
        and(
          eq(projectRepositories.fingerprint, fingerprint),
          eq(projectRepositories.projectId, projectId),
        ),
      )
      .run();
  }

  delete(fingerprint: string, projectId: string): boolean {
    const removed = this.db
      .delete(projectRepositories)
      .where(
        and(
          eq(projectRepositories.fingerprint, fingerprint),
          eq(projectRepositories.projectId, projectId),
        ),
      )
      .returning({ fingerprint: projectRepositories.fingerprint })
      .all();
    return removed.length > 0;
  }

  // admin* — unscoped dashboard reads

  adminListForProject(projectId: string): RepositoryBindingView[] {
    return this.db
      .select(bindingColumns)
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(eq(projectRepositories.projectId, projectId))
      .orderBy(desc(projectRepositories.createdAt))
      .all();
  }

  adminListAll(): RepositoryBindingView[] {
    return this.db
      .select(bindingColumns)
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .orderBy(asc(projects.slug), desc(projectRepositories.createdAt))
      .all();
  }
}

export class PendingRepositoriesRepository {
  constructor(private readonly db: Db) {}

  findById(id: string): RepositoryPending | undefined {
    return this.db.select().from(repositoryPending).where(eq(repositoryPending.id, id)).get();
  }

  findByIdentity(
    fingerprint: string,
    kind: RepositoryPendingKind,
    projectId: string | null,
  ): RepositoryPending | undefined {
    return this.db
      .select()
      .from(repositoryPending)
      .where(
        and(
          eq(repositoryPending.fingerprint, fingerprint),
          eq(repositoryPending.kind, kind),
          sql`coalesce(${repositoryPending.projectId}, '') = ${projectId ?? ''}`,
        ),
      )
      .get();
  }

  listForFingerprint(fingerprint: string): RepositoryPending[] {
    return this.db
      .select()
      .from(repositoryPending)
      .where(eq(repositoryPending.fingerprint, fingerprint))
      .all();
  }

  insert(values: NewRepositoryPending): RepositoryPending {
    return this.db.insert(repositoryPending).values(values).returning().get();
  }

  update(
    id: string,
    values: Partial<Pick<RepositoryPending, 'remotes' | 'rootName' | 'lastSeenAt'>>,
  ): void {
    this.db.update(repositoryPending).set(values).where(eq(repositoryPending.id, id)).run();
  }

  linkToken(pendingId: string, tokenId: string): void {
    this.db
      .insert(repositoryPendingTokens)
      .values({ pendingId, tokenId })
      .onConflictDoNothing()
      .run();
  }

  countLiveForToken(tokenId: string, cutoff: Date): number {
    const row = this.db
      .select({ value: count() })
      .from(repositoryPendingTokens)
      .innerJoin(repositoryPending, eq(repositoryPending.id, repositoryPendingTokens.pendingId))
      .where(
        and(
          eq(repositoryPendingTokens.tokenId, tokenId),
          isNull(repositoryPending.discardedAt),
          gte(repositoryPending.lastSeenAt, cutoff),
        ),
      )
      .get();
    return row?.value ?? 0;
  }

  setDiscardedAt(id: string, discardedAt: Date | null): boolean {
    const changed = this.db
      .update(repositoryPending)
      .set({ discardedAt })
      .where(eq(repositoryPending.id, id))
      .returning({ id: repositoryPending.id })
      .all();
    return changed.length > 0;
  }

  delete(id: string): boolean {
    this.db.delete(repositoryPendingTokens).where(eq(repositoryPendingTokens.pendingId, id)).run();
    const removed = this.db
      .delete(repositoryPending)
      .where(eq(repositoryPending.id, id))
      .returning({ id: repositoryPending.id })
      .all();
    return removed.length > 0;
  }

  // admin* — unscoped dashboard reads

  adminListLive(cutoff: Date): RepositoryPending[] {
    return this.db
      .select()
      .from(repositoryPending)
      .where(and(isNull(repositoryPending.discardedAt), gte(repositoryPending.lastSeenAt, cutoff)))
      .orderBy(desc(repositoryPending.lastSeenAt), asc(repositoryPending.id))
      .all();
  }

  adminListDiscarded(): RepositoryPending[] {
    return this.db
      .select()
      .from(repositoryPending)
      .where(isNotNull(repositoryPending.discardedAt))
      .orderBy(desc(repositoryPending.discardedAt), asc(repositoryPending.id))
      .all();
  }

  adminListTokens(pendingIds: readonly string[]): PendingRepositoryTokenView[] {
    if (pendingIds.length === 0) return [];
    return this.db
      .select({
        pendingId: repositoryPendingTokens.pendingId,
        tokenId: repositoryPendingTokens.tokenId,
        tokenName: tokens.name,
      })
      .from(repositoryPendingTokens)
      .leftJoin(tokens, eq(tokens.id, repositoryPendingTokens.tokenId))
      .where(inArray(repositoryPendingTokens.pendingId, [...pendingIds]))
      .orderBy(asc(repositoryPendingTokens.pendingId), asc(repositoryPendingTokens.tokenId))
      .all();
  }
}
