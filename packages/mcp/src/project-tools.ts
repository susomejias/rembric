import { type ProjectsService } from '@rembric/core';
import type { AgentSessionsService } from '@rembric/core';
import { type Repositories } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
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
};

export interface ProjectToolDeps extends ErrorReportingDeps {
  repos: Pick<Repositories, 'memory'>;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
}

export function buildProjectHandlers(deps: ProjectToolDeps) {
  return {
    list: handleList.bind(null, deps),
    current: handleCurrent.bind(null, deps),
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

async function handleCurrent(deps: ProjectToolDeps, _args: Record<string, never>) {
  void _args;

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
  });
}
