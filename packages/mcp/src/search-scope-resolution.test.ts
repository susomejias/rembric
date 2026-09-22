import { ProjectsService } from '@rembric/core';
import { TokensService, type TokenScope } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import { createRepositories, projectScope, type Project, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readableProjects, resolveSearchScope, type EffectiveScope } from '@rembric/mcp';

import { createTestDb, defaultProject, type TestDb } from './test-support/index.js';

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let tokens: TokensService;
let alpha: Project;
let beta: Project;
let gamma: Project;
let home0: string;
let mintedTokens = 0;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  tokens = new TokensService(repos, db.handle.db);
  mintedTokens = 0;
  home0 = defaultProject(db.handle).id;
  alpha = projects.create({ slug: 'alpha' });
  beta = projects.create({ slug: 'beta' });
  gamma = projects.create({ slug: 'gamma' });
});

afterEach(() => db.cleanup());

function reachOf(scope: TokenScope, memberProjectIds: readonly string[] = []): RequestContext {
  return {
    token: tokens.create({ name: `t-${(mintedTokens += 1)}`, scope: '*' }).token,
    scope,
    memberProjectIds,
    project: null,
    requestedSlug: null,
    mcpSessionId: null,
  };
}

function membersOf(scope: Awaited<ReturnType<typeof widen>>): string[] {
  return scope.kind === 'authorized-projects' ? [...scope.projectIds].sort() : [];
}

function effective(project: Project): EffectiveScope {
  return { scope: projectScope(project.id), project, source: 'url-path' };
}

function widen(
  ctx: RequestContext,
  home: Project,
  acrossProjects: boolean | undefined,
): Promise<ReturnType<typeof resolveSearchScope>> {
  return runWithContext(ctx, () =>
    Promise.resolve(resolveSearchScope({ projects }, effective(home), acrossProjects)),
  );
}

describe('the widened set is the token reach `project.list` publishes', () => {
  it('is every project for a full-access token', async () => {
    const scope = await widen(reachOf('*'), alpha, true);
    expect(membersOf(scope)).toEqual([home0, alpha.id, beta.id, gamma.id].sort());
    expect(scope).toMatchObject({ kind: 'authorized-projects', homeProjectId: alpha.id });
  });

  it('is exactly its members for a set token', async () => {
    const scope = await widen(reachOf('read:projects', [alpha.id, gamma.id]), alpha, true);
    expect(membersOf(scope)).toEqual([alpha.id, gamma.id].sort());
    expect(scope).toMatchObject({ kind: 'authorized-projects', homeProjectId: alpha.id });
  });

  it('is the narrow scope for a project-pinned token, which reaches one', async () => {
    const scope = await widen(reachOf(`read:project:${alpha.id}`), alpha, true);
    expect(scope).toEqual(projectScope(alpha.id));
  });

  it('agrees with what `project.list` would return, over the same request', async () => {
    const ctx = reachOf('projects', [alpha.id, beta.id]);
    const listed = await runWithContext(ctx, () =>
      Promise.resolve(readableProjects(projects, false).map((p) => p.id)),
    );
    const scope = await widen(ctx, alpha, true);

    // Non-vacuity: an empty list would satisfy the equality below.
    expect(listed).toHaveLength(2);
    expect(scope.kind === 'authorized-projects' && scope.projectIds).toEqual(listed);
  });

  it('leaves out an archived project the token could otherwise read', async () => {
    projects.archive(gamma.id);
    const scope = await widen(reachOf('*'), alpha, true);
    expect(membersOf(scope)).toEqual([home0, alpha.id, beta.id].sort());
    expect(membersOf(scope)).not.toContain(gamma.id);
  });

  it('does not widen when the flag is absent or false', async () => {
    expect(await widen(reachOf('*'), alpha, undefined)).toEqual(projectScope(alpha.id));
    expect(await widen(reachOf('*'), alpha, false)).toEqual(projectScope(alpha.id));
  });
});

describe('the widened set is never built without its two preconditions', () => {
  it('falls back to the resolved scope when the home project is not in the reach', async () => {
    projects.archive(alpha.id);
    const scope = await widen(reachOf('*'), alpha, true);

    expect(scope).toEqual(projectScope(alpha.id));
    const control = await widen(reachOf('*'), beta, true);
    expect(control).toMatchObject({ kind: 'authorized-projects', homeProjectId: beta.id });
    expect(membersOf(control)).toEqual([home0, beta.id, gamma.id].sort());
  });

  it('falls back to the resolved scope when the reach is empty', async () => {
    const ctx = reachOf('read:projects', []);
    const listed = await runWithContext(ctx, () =>
      Promise.resolve(readableProjects(projects, false)),
    );

    expect(listed).toEqual([]);
    expect(await widen(ctx, alpha, true)).toEqual(projectScope(alpha.id));
  });

  it('falls back to the resolved scope when the reach is the home project alone', async () => {
    const scope = await widen(reachOf('projects', [alpha.id]), alpha, true);
    expect(scope).toEqual(projectScope(alpha.id));
  });
});
