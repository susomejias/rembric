import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import { type ProjectsService } from '../services/projects.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import { isAuthorized } from '../services/tokens.js';

import { assertAuthorized, routerKey } from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { ok } from './result.js';
import { ensureRootsDiscoveryRun } from './roots-discovery.js';

/**
 * Tool handlers for the `project.*` MCP namespace introduced in change
 * `add-sessions-and-research-tools`.
 *
 * The defaults are conservative:
 *   - `project.use` never auto-creates unless `autocreate: true`
 *   - `project.use` never switches mid-session unless `confirmSwitch: true`
 *   - `project.use` never switches while a session is active (must end first)
 */

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
      memoryCount: z.number(),
    }),
  ),
};

export const projectCurrentOutput = {
  slug: z.string().nullable(),
  projectId: z.string().nullable(),
  source: z.string(),
  suggestedSlugs: z.array(z.string()),
};

export interface ProjectToolDeps {
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
      // Minting a project row is a write, even though project.use is
      // otherwise a read action. A project minted here can never match a
      // project-pinned token id, so gate on an anonymous project target
      // BEFORE creating the row.
      if (!isAuthorized(ctx.scope, 'write', { scope: 'project', projectId: null })) {
        return mcpError(
          'forbidden',
          `token scope '${ctx.scope}' does not authorize creating project '${args.slug}'`,
        );
      }
      try {
        project = deps.projects.create({ slug: args.slug });
        created = true;
      } catch (err) {
        if (err instanceof DomainError) return mcpError(err.code, err.message);
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
    return errToMcp(err);
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
  const ctx = getRequestContext();
  const includeArchived = args.includeArchived === true;
  // Filtered to what the token may read: `*`/`read:*` see all projects,
  // `project:<id>`/`read:project:<id>` see only that project.
  const rows = deps.projects
    .list(includeArchived)
    .filter((p) => isAuthorized(ctx.scope, 'read', { scope: 'project', projectId: p.id }));
  // Memory counts per project — one extra query, batched.
  const counts = deps.repos.memory.countByProject().reduce<Record<string, number>>((acc, r) => {
    acc[r.projectId] = r.n;
    return acc;
  }, {});

  return ok({
    projects: rows.map((p) => ({
      slug: p.slug,
      displayName: p.displayName ?? null,
      archived: p.archivedAt !== null,
      memoryCount: counts[p.id] ?? 0,
    })),
  });
}

async function handleCurrent(deps: ProjectToolDeps, _args: Record<string, never>) {
  void _args;
  const ctx = getRequestContext();
  const key = routerKey();

  // Await any eager (or in-flight) roots discovery; trigger it lazily
  // if no eager run happened. No-op when the URL already pinned a slug,
  // when the client doesn't advertise `roots`, or when discovery already
  // settled for this transport.
  if (key && deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      { tokenId: key.tokenId, mcpSessionId: key.mcpSessionId, pathSlug: ctx.requestedSlug },
    );
  }

  const entry = key ? deps.router.get(key.tokenId, key.mcpSessionId) : undefined;

  const activeProjectId = entry?.projectId ?? ctx.project?.id ?? null;
  try {
    assertAuthorized('read', activeProjectId ? projectScope(activeProjectId) : SCOPE_GLOBAL, deps);
  } catch (err) {
    return errToMcp(err);
  }
  const activeSlug = activeProjectId
    ? (deps.projects.getById(activeProjectId)?.slug ?? null)
    : null;
  const source =
    entry?.projectResolutionSource ??
    (ctx.project ? 'url-path' : ctx.requestedSlug ? 'url-path' : 'none');

  return ok({
    slug: activeSlug,
    projectId: activeProjectId,
    source,
    suggestedSlugs: entry?.pendingSuggestedSlugs ?? [],
  });
}
