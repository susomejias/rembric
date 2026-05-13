import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { DomainError } from '../services/errors.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService, type TokenScope } from '../services/tokens.js';

/**
 * CLI helpers backing the `rembric token ...` subcommands. Each opens
 * the DB, performs the operation, and exits. The server need not be
 * running, but SQLite's WAL mode permits concurrent readers if it is.
 */

export interface CreateTokenArgs {
  name: string;
  project?: string;
  scope?: string;
  expires?: string;
}

export function runTokenCreate(args: CreateTokenArgs): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir });
  try {
    const tokens = new TokensService(handle.db);
    const projects = new ProjectsService(handle.db);

    let projectId: string | null = null;
    if (args.project) {
      const project = projects.findOrCreate(args.project);
      projectId = project.id;
    }

    const scope = resolveScope(args.scope, projectId);
    const expiresAt = parseExpiry(args.expires);

    const { plaintext, token } = tokens.create({
      name: args.name,
      scope,
      projectId,
      expiresAt,
    });

    process.stdout.write(
      JSON.stringify(
        {
          name: token.name,
          scope,
          projectId,
          createdAt: token.createdAt,
          expiresAt: token.expiresAt,
          plaintext,
          warning: 'shown once; store it in your agent config now',
        },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    failWithDomainError(err);
  } finally {
    handle.close();
  }
}

export function runTokenList(): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir });
  try {
    const tokens = new TokensService(handle.db).list();
    const rows = tokens.map((t) => ({
      name: t.name,
      scope: t.scope,
      projectId: t.projectId,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      state: t.revokedAt
        ? 'revoked'
        : t.expiresAt && t.expiresAt < new Date()
          ? 'expired'
          : 'active',
    }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } finally {
    handle.close();
  }
}

export function runTokenRevoke(name: string): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir });
  try {
    new TokensService(handle.db).revoke(name);
    process.stdout.write(JSON.stringify({ ok: true, name, action: 'revoked' }, null, 2) + '\n');
  } catch (err) {
    failWithDomainError(err);
  } finally {
    handle.close();
  }
}

function resolveScope(raw: string | undefined, projectId: string | null): TokenScope {
  if (!raw || raw === '*') {
    return projectId ? `project:${projectId}` : '*';
  }
  if (raw === 'read:*' || raw === '*') return raw;
  if (raw.startsWith('project:') || raw.startsWith('read:project:')) {
    return raw as TokenScope;
  }
  throw new DomainError(
    'invalid_input',
    `unsupported --scope '${raw}'. Use '*', 'read:*', 'project:<id>', or 'read:project:<id>'.`,
  );
}

function parseExpiry(raw: string | undefined): Date | null {
  if (!raw) return null;
  const ts = new Date(raw);
  if (Number.isNaN(ts.getTime())) {
    throw new DomainError('invalid_input', `--expires '${raw}' is not a valid ISO 8601 timestamp`);
  }
  return ts;
}

function failWithDomainError(err: unknown): never {
  if (err instanceof DomainError) {
    process.stderr.write(`rembric: ${err.message}\n`);
    process.exit(err.code === 'conflict' ? 64 : 65);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`rembric: ${message}\n`);
  process.exit(1);
}
