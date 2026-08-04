import { ulid } from 'ulid';

import type { Repositories } from '../db/repositories/index.js';
import { type Project } from '../db/schema/projects.js';

import { DomainError } from './errors.js';

/**
 * Project resolution and lifecycle.
 *
 * Projects identify the scope of a memory beyond `global`. They are
 * identified by an opaque slug — the cross-machine logical identity of
 * the project. The slug appears in the URL path `/mcp/<slug>`, the
 * `project.use({slug})` tool argument, and the `projects.slug` column.
 * Paths never appear in the API or in the DB.
 *
 * `displayName` exists so a rename via the dashboard doesn't change the
 * canonical `slug` identifier, preserving all memory associations.
 */

/**
 * Strict slug regex enforced on creation. Legacy values that pre-date this
 * change (mixed case, dots, underscores) continue to function for read and
 * write — only the `create()` path enforces the new shape.
 */
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export interface ProjectView extends Project {
  /** Computed display label: `displayName` if set, otherwise `slug`. */
  label: string;
}

export class ProjectsService {
  constructor(
    private readonly repos: Pick<Repositories, 'projects'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Look up a project by slug. Returns `undefined` if missing. Never inserts. */
  findBySlug(slug: string): Project | undefined {
    if (slug.length === 0) return undefined;
    return this.repos.projects.findBySlug(slug);
  }

  /**
   * Insert a new project with the given slug.
   *
   * The slug MUST match the strict regex; legacy-shaped values cannot be
   * minted here (they only exist for rows created under v0.1).
   */
  create(input: { slug: string; displayName?: string | null }): Project {
    if (!SLUG_REGEX.test(input.slug)) {
      throw new DomainError(
        'invalid_slug',
        `projects.create: slug '${input.slug}' must match ${SLUG_REGEX.source}`,
      );
    }
    const ts = this.now();
    const inserted = this.repos.projects.insert({
      id: ulid(ts.getTime()),
      slug: input.slug,
      displayName: input.displayName ?? null,
      createdAt: ts,
    });
    if (!inserted) {
      throw new DomainError('conflict', `projects.create: slug '${input.slug}' already exists`);
    }
    return inserted;
  }

  getById(id: string): Project | undefined {
    return this.repos.projects.findById(id);
  }

  /**
   * The project a path-less `/mcp` connection resolves to. Throws rather than
   * returning undefined: migration `0031` creates the row, so its absence is a
   * broken database and not a recoverable request-level condition.
   */
  getDefault(): Project {
    const row = this.repos.projects.findDefault();
    if (!row) {
      throw new Error('no project carries is_default = 1; the database is missing its default');
    }
    return row;
  }

  list(includeArchived = false): ProjectView[] {
    return this.repos.projects.listOrdered(includeArchived).map(withLabel);
  }

  listArchived(): ProjectView[] {
    return this.repos.projects.listArchived().map(withLabel);
  }

  rename(id: string, displayName: string): Project {
    if (displayName.trim().length === 0) {
      throw new DomainError('invalid_input', 'projects.rename: displayName must be non-empty');
    }
    const updated = this.repos.projects.updateDisplayName(id, displayName);
    if (!updated) throw new DomainError('project_not_found', `projects.rename: id=${id}`);
    return updated;
  }

  archive(id: string): Project {
    // No fallback scope sits behind the default project, so archiving it would
    // leave a path-less connection with no resolution and refuse every write it
    // routes. Guarded here rather than in the template: the dashboard's archive
    // endpoint is reachable with a crafted request carrying a valid CSRF token.
    if (this.repos.projects.findDefault()?.id === id) {
      throw new DomainError(
        'conflict',
        `projects.archive: id=${id} is the default project and cannot be archived`,
      );
    }
    const updated = this.repos.projects.setArchivedAt(id, this.now(), true);
    if (!updated) {
      const existing = this.getById(id);
      if (!existing) throw new DomainError('project_not_found', `projects.archive: id=${id}`);
      throw new DomainError('conflict', `projects.archive: id=${id} already archived`);
    }
    return updated;
  }

  unarchive(id: string): Project {
    const updated = this.repos.projects.setArchivedAt(id, null, false);
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

  /**
   * Return up to `limit` slugs whose Levenshtein distance to `input` is ≤
   * `maxDistance` (default 3). Deterministic — no LLM, no embeddings. Used
   * to populate `suggestedSlugs[]` in `project_not_found` responses.
   */
  findSimilarSlugs(input: string, opts: { limit?: number; maxDistance?: number } = {}): string[] {
    const limit = opts.limit ?? 3;
    const maxDistance = opts.maxDistance ?? 3;
    if (input.length === 0) return [];

    const allSlugs = this.repos.projects.listActiveSlugs();

    type Ranked = { slug: string; distance: number };
    const ranked: Ranked[] = [];
    for (const slug of allSlugs) {
      if (slug === input) continue;
      const distance = levenshtein(input, slug);
      if (distance <= maxDistance) ranked.push({ slug, distance });
    }
    ranked.sort((a, b) => a.distance - b.distance || a.slug.localeCompare(b.slug));
    return ranked.slice(0, limit).map((r) => r.slug);
  }
}

function withLabel(row: Project): ProjectView {
  return { ...row, label: row.displayName ?? row.slug };
}

/**
 * Iterative Levenshtein distance. O(n*m) time, O(min(n,m)) space.
 * Pure function; same input always yields same output.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap so `a` is the shorter — keeps memory tight.
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      curr[i] = Math.min(curr[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[a.length]!;
}
