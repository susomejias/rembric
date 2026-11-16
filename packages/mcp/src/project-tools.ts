import { DomainError, getRequestContext, type ProjectsService } from '@rembric/core';
import type { AgentSessionsService, RepositoryBindingsService } from '@rembric/core';
import { type Repositories } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  isUnbound,
  readableProjects,
  resolveEffectiveScopeOrNull,
  type EffectiveScope,
} from './_shared.js';
import { errToMcp, type ErrorReportingDeps } from './errors.js';
import { ok } from './result.js';

export const projectListSchema = {
  includeArchived: z.boolean().optional(),
};

export const projectCurrentSchema = {} as const;

export const projectListOutput = {
  projects: z.array(
    z.object({
      slug: z.string(),
      displayName: z.string().nullable(),
      archived: z.boolean(),
      activeMemoryCount: z.number(),
    }),
  ),
};

export const projectCurrentOutput = {
  slug: z.string().nullable(),
  projectId: z.string().nullable(),
  source: z.string(),
  repository: z
    .object({
      fingerprint: z.string().nullable(),
      boundSlugs: z.array(z.string()),
      conflict: z.boolean(),
    })
    .optional(),
};

export const projectBindRepositorySchema = {
  slug: z.string().min(1).max(128),
};

export const projectBindRepositoryOutput = {
  slug: z.string(),
  fingerprint: z.string(),
  message: z.string(),
};

export interface ProjectToolDeps extends ErrorReportingDeps {
  repos: Pick<Repositories, 'memory'>;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  repositoryBindings: Pick<RepositoryBindingsService, 'visibleBindings' | 'bindUnbound'>;
}

export function buildProjectHandlers(deps: ProjectToolDeps) {
  return {
    list: handleList.bind(null, deps),
    current: handleCurrent.bind(null, deps),
    bindRepository: handleBindRepository.bind(null, deps),
  };
}

function handleList(deps: ProjectToolDeps, args: { includeArchived?: boolean }) {
  const rows = readableProjects(deps.projects, args.includeArchived === true);

  return ok({
    projects: rows.map((p) => ({
      slug: p.slug,
      displayName: p.displayName ?? null,
      archived: p.archivedAt !== null,
      activeMemoryCount: deps.repos.memory.countActiveInScope(p.id),
    })),
  });
}

function repositoryReport(deps: ProjectToolDeps) {
  const ctx = getRequestContext();
  if (ctx.repository === undefined) return {};
  const { fingerprint } = ctx.repository;
  const boundSlugs =
    fingerprint === null
      ? []
      : deps.repositoryBindings.visibleBindings(ctx, fingerprint).map((b) => b.slug);
  const connectionSlug = ctx.requestedSlug;
  const conflict =
    connectionSlug !== null && boundSlugs.length > 0 && !boundSlugs.includes(connectionSlug);
  return { repository: { fingerprint, boundSlugs, conflict } };
}

async function handleCurrent(deps: ProjectToolDeps, _args: Record<string, never>) {
  void _args;

  if (isUnbound()) {
    return ok({ slug: null, projectId: null, source: 'unbound', ...repositoryReport(deps) });
  }

  let resolved: EffectiveScope | null;
  try {
    resolved = await resolveEffectiveScopeOrNull(deps);
    if (resolved) assertAuthorized('read', resolved.scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }

  return ok({
    slug: resolved?.project.slug ?? null,
    projectId: resolved?.project.id ?? null,
    source: resolved?.source ?? 'url-path',
    ...repositoryReport(deps),
  });
}

function handleBindRepository(deps: ProjectToolDeps, args: { slug: string }) {
  const ctx = getRequestContext();
  try {
    if (ctx.scope !== '*') {
      throw new DomainError(
        'admin_token_required',
        'project.bind_repository requires an admin token; ask an admin to bind this repository from the dashboard',
      );
    }
    const fingerprint = ctx.repository?.fingerprint ?? null;
    if (fingerprint === null) {
      throw new DomainError(
        'repository_fingerprint_unavailable',
        'this request carries no repository fingerprint; run the client inside a full git clone with at least one commit',
      );
    }
    const bound = deps.repositoryBindings.bindUnbound({
      fingerprint,
      slug: args.slug,
      createdBy: `token:${ctx.token.id}`,
    });
    return ok({
      ...bound,
      message: `repository bound to project '${bound.slug}'; the binding applies from the next session, and this session's project does not change`,
    });
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}
