import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import { type RelationsService, type RelationView } from '../services/relations.js';
import type { Scope } from '../services/scope.js';

import { requireScope } from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { ok } from './result.js';
import { suggestTopicKey } from './topic-key.js';

/**
 * MCP tool handlers for the relations layer introduced in change
 * `convergent-saves-and-synchronous-judgment`:
 *
 *   memory.suggest_topic_key — deterministic family heuristic, no LLM
 *   memory.judge             — close a pending judgmentId from save
 *   memory.compare           — proactive verdict on two arbitrary memories
 *
 * `memory.save` itself is extended in the existing tools.ts so the
 * legacy entry point still works.
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export const suggestTopicKeySchema = {
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(20_000).optional(),
};

const JUDGE_RELATIONS = [
  'supersedes',
  'conflicts_with',
  'related',
  'compatible',
  'scoped',
  'not_conflict',
] as const;

export const judgeSchema = {
  judgmentId: z.string().min(1).optional(),
  relation: z.enum(JUDGE_RELATIONS).optional(),
  reason: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.unknown().optional(),
  judgments: z
    .array(
      z.object({
        judgmentId: z.string().min(1),
        relation: z.enum(JUDGE_RELATIONS),
        reason: z.string().max(2000).optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(25)
    .optional()
    .describe(
      'Batch: close several judgmentIds (e.g. all of memory.save.candidates[]) in one call.',
    ),
};

const COMPARE_RELATIONS = [
  'supersedes',
  'conflicts_with',
  'related',
  'compatible',
  'scoped',
] as const;

export const compareSchema = {
  memoryIdA: z.string().min(1),
  memoryIdB: z.string().min(1),
  relation: z.enum(COMPARE_RELATIONS),
  reason: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.unknown().optional(),
};

export const suggestTopicKeyOutput = {
  topic_key: z.string(),
};

export const judgeOutput = {
  ok: z.literal(true),
  judgmentId: z.string().optional(),
  relation: z.string().optional(),
  status: z.string().optional(),
  judgedAt: z.string().optional(),
  results: z
    .array(
      z.object({
        ok: z.boolean(),
        judgmentId: z.string(),
        relation: z.string().optional(),
        status: z.string().optional(),
        judgedAt: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
};

export const compareOutput = {
  ok: z.literal(true),
  judgmentId: z.string(),
  relation: z.string(),
  status: z.string(),
};

export interface RelationsToolDeps {
  relations: RelationsService;
  router: SessionRouter;
  projects: ProjectsService;
  /** Set by `createMcpServer` after construction to enable roots discovery. */
  getServer?: () => McpServer;
}

export function buildRelationsHandlers(deps: RelationsToolDeps) {
  return {
    suggestTopicKey: handleSuggestTopicKey.bind(null, deps),
    judge: handleJudge.bind(null, deps),
    compare: handleCompare.bind(null, deps),
  };
}

async function handleSuggestTopicKey(
  deps: RelationsToolDeps,
  args: {
    type: (typeof MEMORY_TYPES)[number];
    title?: string;
    content?: string;
  },
) {
  try {
    await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  return ok({ topic_key: suggestTopicKey(args) });
}

// A missing judgment/memory and an out-of-scope one must be indistinguishable
// (`not_found`) so cross-scope existence never leaks — mirrors memory.get.
function maskNotFound(code: DomainError['code']): string {
  return code === 'memory_not_found' ? 'not_found' : code;
}

async function handleJudge(
  deps: RelationsToolDeps,
  args: {
    judgmentId?: string;
    relation?: (typeof JUDGE_RELATIONS)[number];
    reason?: string;
    confidence?: number;
    evidence?: unknown;
    judgments?: Array<{
      judgmentId: string;
      relation: (typeof JUDGE_RELATIONS)[number];
      reason?: string;
      confidence?: number;
      evidence?: unknown;
    }>;
  },
) {
  const ctx = getRequestContext();

  // Exactly one of the single fields or `judgments` (spec: both/neither → invalid_input).
  const hasSingle = args.judgmentId !== undefined || args.relation !== undefined;
  const hasBatch = args.judgments !== undefined;
  if (hasSingle === hasBatch) {
    return mcpError(
      'invalid_input',
      'provide exactly one of {judgmentId, relation} or {judgments: [...]}',
    );
  }

  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err);
  }

  if (args.judgments !== undefined) {
    // Each item runs in its OWN RelationsService.judge transaction (no outer
    // tx), so a bad id reports an error without rolling back the good ones.
    const results = args.judgments.map((j) => {
      try {
        const row = deps.relations.judgeInScope(j.judgmentId, scope, {
          relation: j.relation,
          reason: j.reason,
          confidence: j.confidence,
          evidence: j.evidence,
          actor: ctx.token.name,
          kind: 'agent',
        });
        return {
          ok: true as const,
          judgmentId: row.judgmentId,
          relation: row.relation,
          status: row.status,
          judgedAt: row.judgedAt,
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            ok: false as const,
            judgmentId: j.judgmentId,
            code: maskNotFound(err.code),
            message: err.message,
          };
        }
        throw err;
      }
    });
    return ok({ ok: true, results });
  }

  if (args.judgmentId === undefined || args.relation === undefined) {
    return mcpError('invalid_input', 'provide either {judgmentId, relation} or {judgments: [...]}');
  }
  try {
    const row = deps.relations.judgeInScope(args.judgmentId, scope, {
      relation: args.relation,
      reason: args.reason,
      confidence: args.confidence,
      evidence: args.evidence,
      actor: ctx.token.name,
      kind: 'agent',
    });
    return ok({
      ok: true,
      judgmentId: row.judgmentId,
      relation: row.relation,
      status: row.status,
      judgedAt: row.judgedAt,
    });
  } catch (err) {
    if (err instanceof DomainError) return mcpError(maskNotFound(err.code), err.message);
    throw err;
  }
}

async function handleCompare(
  deps: RelationsToolDeps,
  args: {
    memoryIdA: string;
    memoryIdB: string;
    relation: (typeof COMPARE_RELATIONS)[number];
    reason?: string;
    confidence: number;
    evidence?: unknown;
  },
) {
  const ctx = getRequestContext();
  if (args.memoryIdA === args.memoryIdB) {
    return mcpError('invalid_input', 'memory.compare: memoryIdA and memoryIdB must differ');
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  try {
    const row = deps.relations.compareInScope(
      {
        sourceId: args.memoryIdA,
        targetId: args.memoryIdB,
        relation: args.relation,
        reason: args.reason,
        confidence: args.confidence,
        evidence: args.evidence,
        actor: ctx.token.name,
        kind: 'agent',
      },
      scope,
    );
    return ok({
      ok: true,
      judgmentId: row.judgmentId,
      relation: row.relation,
      status: row.status,
    });
  } catch (err) {
    if (err instanceof DomainError) {
      return mcpError(maskNotFound(err.code), err.message);
    }
    throw err;
  }
}

// Maintained import for downstream callers that thread RelationView
// through search results.
export type { RelationView };
