import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type DomainError, type RelationsService, type RelationView } from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { SessionRouter } from '@rembric/core';
import { MEMORY_TYPES, type Repositories, type Scope } from '@rembric/db';
import { z } from 'zod';

import { requireScope } from './_shared.js';
import { errToMcp, isDomainError, itemError, mcpError, type ErrorReportingDeps } from './errors.js';
import { batchResult, ok } from './result.js';
import { suggestTopicKey, topicKeyPrefix } from './topic-key.js';

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
  judgments: z
    .array(
      z
        .object({
          judgmentId: z.string().min(1),
          relation: z.enum(JUDGE_RELATIONS),
          reason: z.string().max(2000).optional(),
          confidence: z.number().min(0).max(1).optional(),
          evidence: z.unknown().optional(),
        })
        .strict(),
    )
    .min(1)
    .max(20)
    .describe(
      '1–20 ordered judgments, each in its own transaction. Do not deduplicate; inspect every result. A one-item array judges one candidate.',
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
  /** Null when the title reaches no transliterable token — see `reason`. */
  topic_key: z.string().nullable(),
  /** Present only when `topic_key` is null: why no key could be derived. */
  reason: z.string().optional(),
  /** Whether an active memory in scope already holds this exact key. */
  occupied: z.boolean(),
  occupantId: z.string().optional(),
  occupantTitle: z.string().optional(),
  /** Active in-scope keys sharing a prefix with the suggestion — adopt one instead of minting a synonym. */
  nearby: z.array(z.object({ topicKey: z.string(), title: z.string() })),
};

export const judgeOutput = {
  ok: z.boolean(),
  results: z.array(
    z.object({
      ok: z.boolean(),
      judgmentId: z.string(),
      relation: z.string().optional(),
      status: z.string().optional(),
      judgedAt: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
      errorId: z.string().optional(),
    }),
  ),
};

export const compareOutput = {
  ok: z.literal(true),
  judgmentId: z.string(),
  relation: z.string(),
  status: z.string(),
};

export interface RelationsToolDeps extends ErrorReportingDeps {
  relations: RelationsService;
  router: SessionRouter;
  projects: ProjectsService;
  /** Required for memory.suggest_topic_key's occupied/nearby scoped reads. */
  repos?: Pick<Repositories, 'memory'>;
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
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const suggestion = suggestTopicKey(args);
  if (suggestion.topicKey === null) {
    // Nothing to look up, so the scope-aware probes are skipped entirely.
    return ok({ topic_key: null, reason: suggestion.reason, occupied: false, nearby: [] });
  }
  const topicKey = suggestion.topicKey;
  if (!deps.repos) {
    return ok({ topic_key: topicKey, occupied: false, nearby: [] });
  }
  const projectId = scope.projectId;

  const occupant = deps.repos.memory.findActiveByTopicKey({
    projectId,
    topicKey,
  });
  const nearbyRows = deps.repos.memory.listNearbyTopicKeys({
    projectId,
    prefix: topicKeyPrefix(topicKey),
    excludeExact: topicKey,
    limit: 5,
  });

  return ok({
    topic_key: topicKey,
    occupied: occupant !== undefined,
    ...(occupant ? { occupantId: occupant.id, occupantTitle: occupant.title } : {}),
    nearby: nearbyRows.map((r) => ({ topicKey: r.topicKey, title: r.title })),
  });
}

function maskNotFound(code: DomainError['code']): string {
  return code === 'memory_not_found' ? 'not_found' : code;
}

async function handleJudge(
  deps: RelationsToolDeps,
  args: z.infer<z.ZodObject<typeof judgeSchema>>,
) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
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
      return {
        ok: false as const,
        judgmentId: j.judgmentId,
        ...itemError(err, deps.logInternalError),
      };
    }
  });
  const successes = results.filter((r) => r.ok).length;
  return batchResult(
    { ok: successes > 0, results },
    successes,
    results.filter((r) => !r.ok),
  );
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
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
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
    if (isDomainError(err)) {
      return mcpError(maskNotFound(err.code), err.message);
    }
    throw err;
  }
}

export type { RelationView };
