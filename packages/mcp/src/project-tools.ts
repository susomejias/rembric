import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ProjectsService } from '@rembric/core';
import { isAuthorized } from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { AgentSessionsService } from '@rembric/core';
import type { SessionRouter } from '@rembric/core';
import { projectScope, type Repositories } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  readableProjects,
  resolveEffectiveScopeOrNull,
  routerKey,
  type EffectiveScope,
} from './_shared.js';
import { errToMcp, isDomainError, mcpError, type ErrorReportingDeps } from './errors.js';
import { ok } from './result.js';

export const projectUseSchema = {
  slug: z.string().min(1).max(128),
  autocreate: z.boolean().optional(),
  confirmSwitch: z.boolean().optional(),
};

export const projectListSchema = {
  includeArchived: z.boolean().optional(),
};

export const projectCurrentSchema = {} as const;

export const projectUseOutput = {
  slug: z.string(),
  projectId: z.string(),
  created: z.boolean(),
  switched: z.boolean(),
  source: z.string(),
  previousSlug: z.string().nullable().optional(),
};

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
  suggestedSlugs: z.array(z.string()),
};

export interface ProjectToolDeps extends ErrorReportingDeps {
  repos: Pick<Repositories, 'memory'>;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  router: SessionRouter;
  /** Set by `createMcpServer` after construction to enable roots discovery. */
  getServer?: () => McpServer;
}

export function buildProjectHandlers(deps: ProjectToolDeps) {
  return {
    use: handleUse.bind(null, deps),
    list: handleList.bind(null, deps),
    current: handleCurrent.bind(null, deps),
  };
}

function handleUse(
  deps: ProjectToolDeps,
  args: { slug: string; autocreate?: boolean; confirmSwitch?: boolean },
) {
  const ctx = getRequestContext();
  if (ctx.requestedSlug && ctx.requestedSlug !== args.slug) {
    return mcpError(
      'scope_locked',
      `connection is path-scoped to '${ctx.requestedSlug}'; cannot switch via tool`,
    );
  }
  const key = routerKey();
  const currentEntry = key ? deps.router.get(key.tokenId, key.mcpSessionId) : undefined;
  const currentProjectId = currentEntry?.projectId ?? ctx.project?.id ?? null;

  let project = deps.projects.findBySlug(args.slug);
  let created = false;
  if (!project) {
    if (args.autocreate === true) {
      if (!isAuthorized(ctx, 'write', { scope: 'project', projectId: null })) {
        return mcpError(
          'forbidden',
          `token scope '${ctx.scope}' does not authorize creating project '${args.slug}'`,
        );
      }
      try {
        project = deps.projects.create({ slug: args.slug });
        created = true;
      } catch (err) {
        if (isDomainError(err)) return mcpError(err.code, err.message);
        throw err;
      }
    } else {
      return mcpError('project_not_found', `project '${args.slug}' not found`, {
        suggestedSlugs: deps.projects.findSimilarSlugs(args.slug),
      });
    }
  }

  try {
    assertAuthorized('read', projectScope(project.id), deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }

  if (project.archivedAt) {
    return mcpError('project_archived', `project '${project.slug}' is archived`);
  }

  // Same as currently active → idempotent.
  if (currentProjectId === project.id) {
    return ok({
      slug: project.slug,
      projectId: project.id,
      created,
      switched: false,
      source: currentEntry?.projectResolutionSource ?? 'tool-explicit',
    });
  }

  // Different from active → switch requires confirmation.
  if (currentProjectId !== null) {
    if (args.confirmSwitch !== true) {
      const currentSlug =
        currentEntry?.projectId === project.id
          ? project.slug
          : (deps.projects.getById(currentProjectId)?.slug ?? null);
      return mcpError(
        'project_switch_requires_confirm',
        `switching projects requires confirmSwitch:true`,
        { currentSlug, targetSlug: project.slug },
      );
    }
    // Switch blocked while a session is active.
    const activeSessionId = currentEntry?.rembricSessionId ?? null;
    if (activeSessionId !== null) {
      return mcpError(
        'session_active_must_end',
        `end the active session via memory.session_summary or memory.session_end before switching projects`,
        {
          activeSessionId,
          currentSlug:
            currentEntry?.projectId !== undefined && currentEntry.projectId !== null
              ? (deps.projects.getById(currentEntry.projectId)?.slug ?? null)
              : null,
          targetSlug: project.slug,
        },
      );
    }
  }

  if (key) {
    deps.router.setActiveProject(key.tokenId, key.mcpSessionId, project.id, 'tool-explicit');
  }
  return ok({
    slug: project.slug,
    projectId: project.id,
    created,
    switched: currentProjectId !== null,
    previousSlug:
      currentProjectId !== null ? (deps.projects.getById(currentProjectId)?.slug ?? null) : null,
    source: 'tool-explicit' as const,
  });
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

  const key = routerKey();
  const entry = key ? deps.router.get(key.tokenId, key.mcpSessionId) : undefined;

  return ok({
    slug: resolved?.project?.slug ?? null,
    projectId: resolved?.project?.id ?? null,
    source: resolved?.source ?? 'url-path',
    suggestedSlugs: entry?.pendingSuggestedSlugs ?? [],
  });
}
