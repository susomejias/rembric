import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { DomainError } from '../services/errors.js';
import { ProjectsService } from '../services/projects.js';

/**
 * CLI helpers backing `rembric project ...`. Operators use these to mint
 * projects without leaving the terminal (and without needing to mint a
 * token first, the only other path that creates a project).
 */

export interface ProjectCreateArgs {
  slug: string;
  name?: string;
}

export function runProjectCreate(args: ProjectCreateArgs): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir });
  try {
    const projects = new ProjectsService(handle.db);
    if (projects.findBySlug(args.slug)) {
      process.stderr.write(`rembric: project '${args.slug}' already exists\n`);
      process.exit(1);
      return;
    }
    const project = projects.create({ slug: args.slug, displayName: args.name ?? null });
    process.stdout.write(
      JSON.stringify(
        {
          id: project.id,
          slug: project.slug,
          displayName: project.displayName,
          createdAt: project.createdAt,
        },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    if (err instanceof DomainError) {
      process.stderr.write(`rembric: ${err.message}\n`);
      process.exit(2);
      return;
    }
    throw err;
  } finally {
    handle.close();
  }
}

export interface ProjectListArgs {
  json?: boolean;
  includeArchived?: boolean;
}

export function runProjectList(args: ProjectListArgs = {}): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir, readonly: true });
  try {
    const projects = new ProjectsService(handle.db);
    const rows = projects.list(args.includeArchived ?? false);

    if (args.json === false) {
      process.stdout.write(renderTable(rows));
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            projects: rows.map((p) => ({
              id: p.id,
              slug: p.slug,
              displayName: p.displayName,
              createdAt: p.createdAt,
              archivedAt: p.archivedAt,
            })),
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    handle.close();
  }
}

interface RenderableRow {
  id: string;
  slug: string;
  displayName: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

function renderTable(rows: RenderableRow[]): string {
  if (rows.length === 0) return '(no projects)\n';
  const header = ['slug', 'name', 'id', 'created', 'archived'];
  const lines = rows.map((r) => [
    r.slug,
    r.displayName ?? '',
    r.id,
    r.createdAt.toISOString(),
    r.archivedAt ? r.archivedAt.toISOString() : '',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map((row) => (row[i] ?? '').length)),
  );
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!, ' ')).join('  ');
  return [pad(header), pad(widths.map((w) => '-'.repeat(w))), ...lines.map(pad)].join('\n') + '\n';
}
