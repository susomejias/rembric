import { count, eq, isNotNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { projects, type Project } from '../schema/projects.js';

export class ProjectsRepository {
  constructor(private readonly db: Db) {}

  // ── admin* — unscoped dashboard reads ──────────────────────────────

  adminListAll(): Project[] {
    return this.db.select().from(projects).all();
  }

  adminFindById(id: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
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
