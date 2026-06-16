import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import { DomainError } from '../services/errors.js';
import { type RelationsService, type RelationView } from '../services/relations.js';

import { mcpError } from './errors.js';
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
  judgmentId: z.string().min(1),
  relation: z.enum(JUDGE_RELATIONS),
  reason: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.unknown().optional(),
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
  judgmentId: z.string(),
  relation: z.string(),
  status: z.string(),
  judgedAt: z.string(),
};

export const compareOutput = {
  ok: z.literal(true),
  judgmentId: z.string(),
  relation: z.string(),
  status: z.string(),
};

export interface RelationsToolDeps {
  relations: RelationsService;
}

export function buildRelationsHandlers(deps: RelationsToolDeps) {
  return {
    suggestTopicKey: handleSuggestTopicKey,
    judge: handleJudge.bind(null, deps),
    compare: handleCompare.bind(null, deps),
  };
}

function handleSuggestTopicKey(args: {
  type: (typeof MEMORY_TYPES)[number];
  title?: string;
  content?: string;
}) {
  return ok({ topic_key: suggestTopicKey(args) });
}

function handleJudge(
  deps: RelationsToolDeps,
  args: {
    judgmentId: string;
    relation: (typeof JUDGE_RELATIONS)[number];
    reason?: string;
    confidence?: number;
    evidence?: unknown;
  },
) {
  const ctx = getRequestContext();
  try {
    const row = deps.relations.judge(args.judgmentId, {
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
    if (err instanceof DomainError) return mcpError(err.code, err.message);
    throw err;
  }
}

function handleCompare(
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
  try {
    const row = deps.relations.compare({
      sourceId: args.memoryIdA,
      targetId: args.memoryIdB,
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
    });
  } catch (err) {
    if (err instanceof DomainError) {
      const code =
        err.code === 'forbidden' && err.message.includes('cross_scope')
          ? 'cross_scope_relation'
          : err.code;
      return mcpError(code, err.message);
    }
    throw err;
  }
}

// Maintained import for downstream callers that thread RelationView
// through search results.
export type { RelationView };
