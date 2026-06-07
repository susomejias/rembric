import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { projects, type NewProject, type Project } from '../schema/projects.js';

export class ProjectsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewProject): Project | undefined {
    return this.db.insert(projects).values(values).returning().get();
  }

  findById(id: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  findBySlug(slug: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.slug, slug)).get();
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

  listAllIds(): string[] {
    return this.db
      .select({ id: projects.id })
      .from(projects)
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
