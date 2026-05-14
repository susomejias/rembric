import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 13.23 — CLI surface tests.
 *
 * The CLI is just a thin Commander router over per-action functions. We
 * exercise the actions directly (no child-process spawn), asserting:
 *   - happy-path actions emit parseable JSON / non-empty output and exit 0
 *   - failure paths exit non-zero with a descriptive message
 *
 * Each test stubs `process.exit` and captures `process.stdout/stderr.write`
 * so the assertions can run without actually terminating the test
 * process.
 */

const ENV_BASE = {
  REMBRIC_ADMIN_TOKEN: 'cli-test-token-with-enough-entropy-zzz',
  EMBEDDING_ENABLED: 'false',
  CONSOLIDATION_ENABLED: 'false',
  OPENAI_API_KEY: 'sk-test',
} as const;

interface CapturedRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function captureExit(fn: () => Promise<void>): Promise<CapturedRun> {
  let exitCode: number | null = null;
  let stdout = '';
  let stderr = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal(exitCode);
  }) as never);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += chunk.toString();
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += chunk.toString();
    return true;
  });
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { exitCode, stdout, stderr };
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe('CLI action functions', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-cli-test-'));
    Object.assign(process.env, ENV_BASE, { REMBRIC_DATA_DIR: dataDir });
  });
  afterEach(() => {
    delete process.env.REMBRIC_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('db migrate runs migrations and exits cleanly', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { exitCode, stdout } = await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    expect(exitCode === 0 || exitCode === null).toBe(true);
    const parsed = JSON.parse(stdout) as { ok?: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('status prints JSON with the expected top-level keys', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runStatus } = await import('./server-status.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    const { stdout } = await captureExit(() => {
      runStatus();
      return Promise.resolve();
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('memories');
    expect(parsed).toHaveProperty('projects');
    expect(parsed).toHaveProperty('tokens');
    expect(parsed).toHaveProperty('dataDir');
  });

  it('project create mints a project and list contains its slug', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runProjectCreate, runProjectList } = await import('./project-cli.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    const { exitCode, stdout } = await captureExit(() => {
      runProjectCreate({ slug: 'cli-test-project', name: 'CLI Test' });
      return Promise.resolve();
    });
    expect(exitCode === 0 || exitCode === null).toBe(true);
    const parsed = JSON.parse(stdout) as { slug: string; displayName: string | null };
    expect(parsed.slug).toBe('cli-test-project');
    expect(parsed.displayName).toBe('CLI Test');

    const { stdout: listOut } = await captureExit(() => {
      runProjectList({ json: true });
      return Promise.resolve();
    });
    const listed = JSON.parse(listOut) as { projects: { slug: string }[] };
    expect(listed.projects.some((p) => p.slug === 'cli-test-project')).toBe(true);
  });

  it('project create with an invalid slug exits 2', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runProjectCreate } = await import('./project-cli.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    const { exitCode, stderr } = await captureExit(() => {
      runProjectCreate({ slug: 'INVALID Slug!' });
      return Promise.resolve();
    });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/slug/i);
  });

  it('project create rejects a duplicate slug with exit 1', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runProjectCreate } = await import('./project-cli.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    await captureExit(() => {
      runProjectCreate({ slug: 'dup-project' });
      return Promise.resolve();
    });
    const { exitCode, stderr } = await captureExit(() => {
      runProjectCreate({ slug: 'dup-project' });
      return Promise.resolve();
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/already exists/i);
  });

  it('session delete soft-deletes the row and list hides it by default', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runSessionDelete, runSessionList } = await import('./session-cli.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });

    // Bootstrap an admin token + a project + a session via direct DB access.
    const { createDb } = await import('../db/index.js');
    const { loadConfig } = await import('../config.js');
    const { ProjectsService } = await import('../services/projects.js');
    const { TokensService } = await import('../services/tokens.js');
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');
    const cfg = loadConfig();
    const handle = createDb({ dataDir: cfg.dataDir });
    const tokensSvc = new TokensService(handle.db);
    tokensSvc.bootstrapAdmin(ENV_BASE.REMBRIC_ADMIN_TOKEN);
    const admin = handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get();
    const proj = new ProjectsService(handle.db).create({ slug: 'cli-del-proj' });
    const sess = new AgentSessionsService(handle.db).start({
      tokenId: admin!.id,
      projectId: proj.id,
      agent: 'cli-test',
    });
    handle.close();

    // Delete the session via the CLI surface.
    const { exitCode, stdout } = await captureExit(() => {
      runSessionDelete({ id: sess.id });
      return Promise.resolve();
    });
    expect(exitCode === 0 || exitCode === null).toBe(true);
    const parsed = JSON.parse(stdout) as { id: string; deletedAt: string | null };
    expect(parsed.id).toBe(sess.id);
    expect(parsed.deletedAt).not.toBeNull();

    // Default list does NOT include the deleted row.
    const { stdout: defaultList } = await captureExit(() => {
      runSessionList({ json: true });
      return Promise.resolve();
    });
    const listed = JSON.parse(defaultList) as { sessions: { id: string }[] };
    expect(listed.sessions.some((r) => r.id === sess.id)).toBe(false);

    // With --include-deleted the row reappears.
    const { stdout: allList } = await captureExit(() => {
      runSessionList({ json: true, includeDeleted: true });
      return Promise.resolve();
    });
    const allListed = JSON.parse(allList) as { sessions: { id: string }[] };
    expect(allListed.sessions.some((r) => r.id === sess.id)).toBe(true);
  });

  it('session delete on an unknown id exits non-zero', async () => {
    const { runDbMigrate } = await import('./db-migrate.js');
    const { runSessionDelete } = await import('./session-cli.js');
    await captureExit(() => {
      runDbMigrate();
      return Promise.resolve();
    });
    const { exitCode, stderr } = await captureExit(() => {
      runSessionDelete({ id: 'not-a-real-ulid' });
      return Promise.resolve();
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not found/i);
  });

  it('consolidation run-now without --token exits non-zero', async () => {
    delete process.env.REMBRIC_ADMIN_TOKEN;
    const { runConsolidationRunNow } = await import('./consolidation-cli.js');
    const { exitCode, stderr } = await captureExit(async () => {
      await runConsolidationRunNow({});
    });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/token/i);
    process.env.REMBRIC_ADMIN_TOKEN = ENV_BASE.REMBRIC_ADMIN_TOKEN;
  });

  it('consolidation run-now against an unreachable server exits 1 with code=unreachable', async () => {
    const { runConsolidationRunNow } = await import('./consolidation-cli.js');
    const { exitCode, stdout } = await captureExit(async () => {
      await runConsolidationRunNow({
        token: 'doesnotmatter',
        url: 'http://127.0.0.1:1',
      });
    });
    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout) as { code?: string };
    expect(payload.code).toBe('unreachable');
  });
});
