import { basename } from 'node:path';

import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { projects, type Project } from '../db/schema/projects.js';

import { DomainError } from './errors.js';

/**
 * Project resolution and lifecycle.
 *
 * Projects identify the scope of a memory beyond `global`. They are
 * resolved either by absolute filesystem path (when an agent passes one)
 * or by an opaque external name carried in `X-Rembric-Project`.
 *
 * `displayName` exists so a rename via the dashboard doesn't change the
 * canonical `path` identifier, preserving all memory associations.
 */

export interface ProjectView extends Project {
  /** Computed display label: `displayName` if set, otherwise `basename(path)`. */
  label: string;
}

export class ProjectsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findOrCreate(path: string): Project {
    if (path.trim().length === 0) {
      throw new DomainError('invalid_input', 'projects.findOrCreate: path must be non-empty');
    }
    const existing = this.db.select().from(projects).where(eq(projects.path, path)).get();
    if (existing) return existing;

    const ts = this.now();
    const inserted = this.db
      .insert(projects)
      .values({ id: ulid(ts.getTime()), path, createdAt: ts })
      .returning()
      .get();
    if (!inserted) {
      // Race: another writer created it in between. Fetch again.
      const recovered = this.db.select().from(projects).where(eq(projects.path, path)).get();
      if (!recovered) throw new DomainError('conflict', 'projects.findOrCreate: race condition');
      return recovered;
    }
    return inserted;
  }

  getById(id: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  list(includeArchived = false): ProjectView[] {
    const rows = includeArchived
      ? this.db.select().from(projects).orderBy(asc(projects.createdAt)).all()
      : this.db
          .select()
          .from(projects)
          .where(isNull(projects.archivedAt))
          .orderBy(asc(projects.createdAt))
          .all();
    return rows.map((row) => ({
      ...row,
      label: row.displayName ?? (basename(row.path) || row.path),
    }));
  }

  listArchived(): ProjectView[] {
    const rows = this.db
      .select()
      .from(projects)
      .where(isNotNull(projects.archivedAt))
      .orderBy(asc(projects.createdAt))
      .all();
    return rows.map((row) => ({
      ...row,
      label: row.displayName ?? (basename(row.path) || row.path),
    }));
  }

  rename(id: string, displayName: string): Project {
    if (displayName.trim().length === 0) {
      throw new DomainError('invalid_input', 'projects.rename: displayName must be non-empty');
    }
    const updated = this.db
      .update(projects)
      .set({ displayName })
      .where(eq(projects.id, id))
      .returning()
      .get();
    if (!updated) throw new DomainError('project_not_found', `projects.rename: id=${id}`);
    return updated;
  }

  archive(id: string): Project {
    const ts = this.now();
    const updated = this.db
      .update(projects)
      .set({ archivedAt: ts })
      .where(and(eq(projects.id, id), isNull(projects.archivedAt)))
      .returning()
      .get();
    if (!updated) {
      const existing = this.getById(id);
      if (!existing) throw new DomainError('project_not_found', `projects.archive: id=${id}`);
      throw new DomainError('conflict', `projects.archive: id=${id} already archived`);
    }
    return updated;
  }

  unarchive(id: string): Project {
    const updated = this.db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, id))
      .returning()
      .get();
    if (!updated) throw new DomainError('project_not_found', `projects.unarchive: id=${id}`);
    return updated;
  }

  /**
   * Assert that a project exists and is not archived. Used as a guard by
   * write paths that would otherwise admit data into an archived project.
   */
  assertWritable(id: string): void {
    const project = this.getById(id);
    if (!project) {
      throw new DomainError('project_not_found', `project not found: ${id}`);
    }
    if (project.archivedAt) {
      throw new DomainError(
        'project_archived',
        `project ${id} is archived; new writes are rejected`,
      );
    }
  }
}
