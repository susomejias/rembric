// PROTOTYPE of the stale save-time pending drain. Not production code; imported by the measurement scripts beside it.
// Writes go only through repository/service APIs. Reads with no repository method yet are marked STAND-IN READ.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = new URL('../../../../', import.meta.url);
const coreRequire = createRequire(new URL('packages/core/package.json', ROOT));
const repoFile = (rel: string) => import(new URL(rel, ROOT).href);

export const db = await repoFile('packages/db/src/index.ts');
export const core = await repoFile('packages/core/src/index.ts');
export const ops = await repoFile('packages/core/src/consolidation/operations.ts');
export const { TestClock } = await repoFile('packages/core/src/test-support/clock.ts');
const drizzle = await import(
  pathToFileURL(join(dirname(coreRequire.resolve('drizzle-orm')), 'index.js')).href
);
export const sql = drizzle.sql;
export const { ulid } = await import(pathToFileURL(coreRequire.resolve('ulid')).href);

export const LEXICAL_FLOOR: number = core.LEXICAL_CANDIDATE_FLOOR;
export const VEC_THRESHOLD: number = core.VEC_THRESHOLD;
export const STALE_PREFIX = 'stale under current rules';
export const RETIRED_PREFIX = 'endpoint retired';

/** Measured in bounds.txt: the largest per-endpoint size whose large->large pair stays <= 5 ms (design D3). */
export const DRAIN_MAX_PAIR_CHARS = 64_000;

/**
 * v1 = the rules first handed over; v2 = the owner's retired-endpoint decision and review B3/B2;
 * v3 = the design's alignment: undo is final for every drain, the size bound keeps before any channel.
 */
export interface Rules {
  retiredDrain: boolean;
  reextract: boolean;
  undoFinal: boolean;
  maxPairChars?: number;
}
export const RULES_V1: Rules = { retiredDrain: false, reextract: false, undoFinal: false };
export const RULES_V2: Rules = { retiredDrain: true, reextract: true, undoFinal: false };
export const RULES_V3: Rules = {
  retiredDrain: true,
  reextract: true,
  undoFinal: true,
  maxPairChars: DRAIN_MAX_PAIR_CHARS,
};

export interface PendingRef {
  judgmentId: string;
  sourceId: string;
  targetId: string;
  createdAt?: number;
}

export type Channel = 'lexical' | 'vector' | 'entity';

export interface PairCheck {
  endpoint: 'ok' | 'missing' | 'out-of-scope' | 'retired' | 'error';
  sourceStatus?: string;
  targetStatus?: string;
  lexical: number | null;
  vector: number | 'missing' | 'index-not-current' | null;
  shared: string[] | null;
  reextracted: string[] | null;
  admitted: Channel[];
  entityUnknown?: 'scan-missing' | 'extract-failed';
  oversize?: boolean;
  error?: string;
}

export type Verdict = 'drained' | 'kept' | 'not-pending' | 'write-failed';

export interface Decision extends PendingRef {
  verdict: Verdict;
  reason: string;
  check: PairCheck;
  run: number;
}

export type SelectionOrder = 'judgment_id' | 'created_at';

export interface DrainReads {
  order: SelectionOrder;
  selectBatch(projectId: string, cursor: string | null, limit: number): PendingRef[];
  cursorOf(pair: PendingRef): string;
  pairCosineDistance(sourceId: string, targetId: string): number | undefined;
  scannedCount(sourceId: string, targetId: string): number;
  undoneDrainIds(): Map<string, 'stale' | 'retired'>;
  revertedOrphanIds(judgmentIds: string[]): Set<string>;
  endpointRows(sourceId: string, targetId: string, maxChars: number): EndpointRow[];
}

export interface EndpointRow {
  id: string;
  status: string;
  scope: string;
  projectId: string | null;
  title: string;
  chars: number;
  content: string | null;
}

export interface Amendments {
  entityScanGuard?: boolean;
  skipUndone?: boolean;
}

export interface DrainHooks {
  beforeWrite?: (pair: PendingRef) => void;
}

export interface DrainContext {
  handle: any;
  repos: any;
  reads: DrainReads;
  rules: Rules;
  vectorIndexCurrent: () => boolean;
  extract: (title: string, content: string) => { kind: string; value: string }[];
  clock: () => number;
  hooks?: DrainHooks;
  embedder?: unknown;
}

export function openDb(dataDir: string): any {
  return db.createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
}

export function createReads(handle: any, order: SelectionOrder = 'judgment_id'): DrainReads {
  // STAND-IN READ (proposed RelationsRepository method): scoped pending rows after a cursor, owner's judgment_id order.
  const byJudgmentId = (
    projectId: string,
    cursor: string,
    limit: number,
    wrap: boolean,
  ): PendingRef[] =>
    handle.db.all(sql`
      SELECT r.judgment_id AS judgmentId, r.source_id AS sourceId, r.target_id AS targetId
      FROM memory_relations r
      JOIN memory ms ON ms.id = r.source_id
      JOIN memory mt ON mt.id = r.target_id
      WHERE r.status = 'pending'
        AND ${wrap ? sql`r.judgment_id <= ${cursor}` : sql`r.judgment_id > ${cursor}`}
        AND ms.scope = 'project' AND ms.project_id = ${projectId}
        AND mt.scope = 'project' AND mt.project_id = ${projectId}
      ORDER BY r.judgment_id
      LIMIT ${limit}
    `);
  // STAND-IN READ (efficiency variant): the same rows in (created_at, judgment_id) order, served by memory_relations_status_created_idx.
  const byCreatedAt = (
    projectId: string,
    at: number,
    id: string,
    limit: number,
    wrap: boolean,
  ): PendingRef[] =>
    handle.db.all(sql`
      SELECT r.judgment_id AS judgmentId, r.source_id AS sourceId, r.target_id AS targetId, r.created_at AS createdAt
      FROM memory_relations r
      JOIN memory ms ON ms.id = r.source_id
      JOIN memory mt ON mt.id = r.target_id
      WHERE r.status = 'pending'
        AND ${wrap ? sql`(r.created_at, r.judgment_id) <= (${at}, ${id})` : sql`(r.created_at, r.judgment_id) > (${at}, ${id})`}
        AND ms.scope = 'project' AND ms.project_id = ${projectId}
        AND mt.scope = 'project' AND mt.project_id = ${projectId}
      ORDER BY r.created_at, r.judgment_id
      LIMIT ${limit}
    `);
  const decode = (cursor: string): [number, string] => {
    const i = cursor.indexOf('|');
    return [Number(cursor.slice(0, i)), cursor.slice(i + 1)];
  };
  return {
    order,
    selectBatch(projectId, cursor, limit) {
      if (order === 'judgment_id') {
        const first = byJudgmentId(projectId, cursor ?? '', limit, false);
        if (cursor === null || first.length >= limit) return first;
        return [...first, ...byJudgmentId(projectId, cursor, limit - first.length, true)];
      }
      const [at, id] = cursor === null ? [-1, ''] : decode(cursor);
      const first = byCreatedAt(projectId, at, id, limit, false);
      if (cursor === null || first.length >= limit) return first;
      return [...first, ...byCreatedAt(projectId, at, id, limit - first.length, true)];
    },
    cursorOf(pair) {
      return order === 'judgment_id' ? pair.judgmentId : `${pair.createdAt}|${pair.judgmentId}`;
    },
    pairCosineDistance(sourceId, targetId) {
      // STAND-IN READ (proposed VectorsRepository method): the save path's vec_distance_cosine over two stored vectors.
      const row = handle.db.get(sql`
        SELECT vec_distance_cosine(a.embedding, b.embedding) AS distance
        FROM memory_vec a, memory_vec b
        WHERE a.memory_id = ${sourceId} AND b.memory_id = ${targetId}
      `) as { distance: number } | undefined;
      return row?.distance;
    },
    scannedCount(sourceId, targetId) {
      // STAND-IN READ (v1 amendment probe only): how many of the two endpoints have an entity scan row.
      const row = handle.db.get(sql`
        SELECT count(*) AS n FROM memory_entity_scan WHERE memory_id IN (${sourceId}, ${targetId})
      `) as { n: number };
      return row.n;
    },
    undoneDrainIds() {
      // STAND-IN READ (proposed ConsolidationRepository method): judgment ids whose drain op an operator reverted.
      const rows = handle.db.all(sql`
        SELECT created_id AS id, reasoning FROM consolidation_ops
        WHERE op_type = 'orphan_promote' AND reverted_at IS NOT NULL
          AND (reasoning LIKE ${`orphaned: ${STALE_PREFIX}:%`} OR reasoning LIKE ${`orphaned: ${RETIRED_PREFIX}:%`})
      `) as { id: string; reasoning: string }[];
      return new Map(
        rows.map((r) => [
          r.id,
          r.reasoning.startsWith(`orphaned: ${RETIRED_PREFIX}:`) ? 'retired' : 'stale',
        ]),
      );
    },
    revertedOrphanIds(judgmentIds) {
      if (judgmentIds.length === 0) return new Set();
      // STAND-IN READ (design D7): reverted orphan_promote ops for the batch's judgment ids; created_id has no index.
      const rows = handle.db.all(sql`
        SELECT created_id AS id FROM consolidation_ops
        WHERE op_type = 'orphan_promote' AND reverted_at IS NOT NULL
          AND created_id IN (SELECT value FROM json_each(${JSON.stringify(judgmentIds)}))
      `) as { id: string }[];
      return new Set(rows.map((r) => r.id));
    },
    endpointRows(sourceId, targetId, maxChars) {
      // STAND-IN READ (design D3): status and length first; content only when within the size bound.
      return handle.db.all(sql`
        SELECT id, status, scope, project_id AS projectId, title,
               length(title) + length(content) AS chars,
               CASE WHEN length(title) + length(content) <= ${maxChars} THEN content END AS content
        FROM memory WHERE id IN (${sourceId}, ${targetId})
      `) as EndpointRow[];
    },
  };
}

export function createContext(handle: any, extra: Partial<DrainContext> = {}): DrainContext {
  return {
    handle,
    repos: extra.repos ?? db.createRepositories(handle.db),
    reads: extra.reads ?? createReads(handle),
    rules: extra.rules ?? RULES_V3,
    vectorIndexCurrent: extra.vectorIndexCurrent ?? (() => true),
    extract: extra.extract ?? core.extractEntities,
    clock: extra.clock ?? (() => performance.now()),
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
    ...(extra.embedder ? { embedder: extra.embedder } : {}),
  };
}

export interface RecheckOptions {
  mode?: 'full' | 'short';
  amend?: Amendments;
  vectorCurrent?: boolean;
}

const keyOf = (e: { kind: string; value: string }) => `${e.kind}:${e.value}`;

export function recheckPair(
  ctx: DrainContext,
  pair: PendingRef,
  projectId: string,
  opts: RecheckOptions = {},
): PairCheck {
  const mode = opts.mode ?? 'full';
  const base: PairCheck = {
    endpoint: 'ok',
    lexical: null,
    vector: null,
    shared: null,
    reextracted: null,
    admitted: [],
  };
  const bounded = ctx.rules.maxPairChars !== undefined;
  const rows: any[] = bounded
    ? ctx.reads.endpointRows(pair.sourceId, pair.targetId, ctx.rules.maxPairChars!)
    : ctx.repos.memory.unsafeGetByIds([pair.sourceId, pair.targetId]);
  const a = rows.find((r: any) => r.id === pair.sourceId);
  const b = rows.find((r: any) => r.id === pair.targetId);
  if (!a || !b) return { ...base, endpoint: 'missing' };
  const sourceStatus = a.status;
  const targetStatus = b.status;
  if (
    a.scope !== 'project' ||
    b.scope !== 'project' ||
    a.projectId !== projectId ||
    b.projectId !== projectId
  ) {
    return { ...base, endpoint: 'out-of-scope', sourceStatus, targetStatus };
  }
  if (sourceStatus !== 'active' || targetStatus !== 'active') {
    return { ...base, endpoint: 'retired', sourceStatus, targetStatus };
  }
  const check: PairCheck = { ...base, sourceStatus, targetStatus };
  if (bounded && (a.content === null || b.content === null)) {
    check.oversize = true;
    return check;
  }
  const targetText = `${b.title}\n\n${b.content}`;
  check.lexical = core.tokenContainment(core.tokenSet(a.content), core.tokenSet(targetText));
  if (check.lexical >= LEXICAL_FLOOR) check.admitted.push('lexical');
  if (mode === 'short' && check.admitted.length > 0) return check;

  if (opts.vectorCurrent === false) {
    check.vector = 'index-not-current';
  } else {
    const distance = ctx.reads.pairCosineDistance(a.id, b.id);
    check.vector = distance === undefined ? 'missing' : 1 - Math.max(0, Math.min(1, distance));
    if (typeof check.vector === 'number' && check.vector >= VEC_THRESHOLD)
      check.admitted.push('vector');
  }
  if (mode === 'short' && check.admitted.length > 0) return check;

  const stored = ctx.repos.entities.findEntitiesForMemories([a.id, b.id]);
  const storedSource = new Set((stored.get(a.id) ?? []).map(keyOf));
  check.shared = (stored.get(b.id) ?? []).map(keyOf).filter((k: string) => storedSource.has(k));
  if (check.shared!.length > 0) check.admitted.push('entity');

  if (ctx.rules.reextract && check.shared!.length === 0) {
    try {
      const fresh = new Set(ctx.extract(a.title, a.content).map(keyOf));
      check.reextracted = [...new Set(ctx.extract(b.title, b.content).map(keyOf))].filter((k) =>
        fresh.has(k),
      );
      if (check.reextracted.length > 0) check.admitted.push('entity');
    } catch {
      check.entityUnknown = 'extract-failed';
    }
  }
  if (!check.admitted.includes('entity') && !check.entityUnknown && opts.amend?.entityScanGuard) {
    if (ctx.reads.scannedCount(a.id, b.id) < 2) check.entityUnknown = 'scan-missing';
  }
  return check;
}

export type Action = { kind: 'keep' | 'stale' | 'retired'; reason: string };

export function decide(check: PairCheck, rules: Rules): Action {
  if (check.endpoint === 'error') return { kind: 'keep', reason: 'fail-safe:error' };
  if (check.endpoint === 'missing' || check.endpoint === 'out-of-scope') {
    return { kind: 'keep', reason: `fail-safe:endpoint-${check.endpoint}` };
  }
  if (check.endpoint === 'retired') {
    return rules.retiredDrain
      ? { kind: 'retired', reason: 'drained:retired' }
      : { kind: 'keep', reason: 'fail-safe:endpoint-not-active' };
  }
  if (check.admitted.length > 0) return { kind: 'keep', reason: check.admitted[0]! };
  if (check.vector === 'missing') return { kind: 'keep', reason: 'fail-safe:vector-unknown' };
  if (check.vector === 'index-not-current')
    return { kind: 'keep', reason: 'fail-safe:vector-index-not-current' };
  if (check.oversize) return { kind: 'keep', reason: 'fail-safe:content-too-large' };
  if (check.entityUnknown)
    return { kind: 'keep', reason: `fail-safe:entity-unknown(${check.entityUnknown})` };
  return { kind: 'stale', reason: 'drained:stale' };
}

/** Null means "drain". */
export function keepReason(check: PairCheck, rules: Rules = RULES_V3): string | null {
  const a = decide(check, rules);
  return a.kind === 'keep' ? a.reason : null;
}

function reasoning(action: Action, check: PairCheck): string {
  if (action.kind === 'retired') {
    return `${RETIRED_PREFIX}: source ${check.sourceStatus}, target ${check.targetStatus}`;
  }
  const lex = (check.lexical ?? 0).toFixed(3);
  const vec = typeof check.vector === 'number' ? check.vector.toFixed(3) : 'n/a';
  return `${STALE_PREFIX}: lexical ${lex} < ${LEXICAL_FLOOR}, vector ${vec} < ${VEC_THRESHOLD}, no shared entity`;
}

export interface RunOptions {
  projectId: string;
  batch: number;
  cursor: string | null;
  budgetMs?: number;
  /** Absolute clock() value shared by every drain step of one sweep call (design D7). */
  deadlineAt?: number;
  useCursor?: boolean;
  mode?: 'full' | 'short';
  runIndex?: number;
  amend?: Amendments;
  /** Cost probe only, on a throwaway copy: writes every examined pair, so a run pays the drain path for all B. */
  forceDrainForCost?: boolean;
}

export interface RunResult {
  runId: string;
  selected: number;
  examined: number;
  drained: number;
  drainedRetired: number;
  kept: number;
  keptAdmitted: number;
  keptUnknown: number;
  excludedUndone: number;
  notPending: number;
  writeFailed: number;
  cursor: string | null;
  stopReason: 'cap' | 'budget' | 'exhausted';
  ms: number;
  decisions: Decision[];
}

export function runDrain(ctx: DrainContext, opts: RunOptions): RunResult {
  const t0 = performance.now();
  const c0 = ctx.clock();
  const deadline =
    opts.deadlineAt ??
    (opts.budgetMs !== undefined ? c0 + opts.budgetMs : Number.POSITIVE_INFINITY);
  const startedAt = new Date();
  const runId = ulid(startedAt.getTime());
  ctx.repos.consolidation.insertRun({ id: runId, startedAt, scope: `project:${opts.projectId}` });
  const vectorCurrent = ctx.vectorIndexCurrent();
  const startCursor = opts.useCursor === false ? null : opts.cursor;
  const batch = ctx.reads.selectBatch(opts.projectId, startCursor, opts.batch);
  const excluded = ctx.rules.undoFinal
    ? ctx.reads.revertedOrphanIds(batch.map((p) => p.judgmentId))
    : null;
  const undone =
    !ctx.rules.undoFinal && (ctx.rules.retiredDrain || opts.amend?.skipUndone)
      ? ctx.reads.undoneDrainIds()
      : null;
  const result: RunResult = {
    runId,
    selected: batch.length,
    examined: 0,
    drained: 0,
    drainedRetired: 0,
    kept: 0,
    keptAdmitted: 0,
    keptUnknown: 0,
    excludedUndone: 0,
    notPending: 0,
    writeFailed: 0,
    cursor: opts.cursor,
    stopReason: batch.length < opts.batch ? 'exhausted' : 'cap',
    ms: 0,
    decisions: [],
  };
  for (const pair of batch) {
    if (result.examined > 0 && ctx.clock() >= deadline) {
      result.stopReason = 'budget';
      break;
    }
    if (excluded?.has(pair.judgmentId)) {
      result.cursor = ctx.reads.cursorOf(pair);
      result.excludedUndone += 1;
      result.decisions.push({
        ...pair,
        verdict: 'kept',
        reason: 'excluded:operator-undo',
        check: {
          endpoint: 'ok',
          lexical: null,
          vector: null,
          shared: null,
          reextracted: null,
          admitted: [],
        },
        run: opts.runIndex ?? 0,
      });
      continue;
    }
    result.examined += 1;
    result.cursor = ctx.reads.cursorOf(pair);
    let check: PairCheck;
    try {
      check = recheckPair(ctx, pair, opts.projectId, {
        mode: opts.mode ?? 'full',
        ...(opts.amend ? { amend: opts.amend } : {}),
        vectorCurrent,
      });
    } catch (err) {
      check = {
        endpoint: 'error',
        lexical: null,
        vector: null,
        shared: null,
        reextracted: null,
        admitted: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    let action = decide(check, ctx.rules);
    if (opts.forceDrainForCost) action = { kind: 'stale', reason: 'drained:stale' };
    else if (
      undone?.has(pair.judgmentId) &&
      (action.kind === 'retired' || (action.kind === 'stale' && opts.amend?.skipUndone))
    ) {
      action = { kind: 'keep', reason: 'kept:operator-undo' };
    }
    const decision: Decision = {
      ...pair,
      verdict: 'kept',
      reason: action.reason,
      check,
      run: opts.runIndex ?? 0,
    };
    if (action.kind !== 'keep') {
      const text = reasoning(action, check);
      try {
        ctx.hooks?.beforeWrite?.(pair);
        const changed = ctx.handle.db.transaction(() => {
          const updated = ctx.repos.relations.markOrphanedPending(pair.judgmentId, {
            reason: text,
            markedByKind: 'consolidator',
            judgedAt: new Date(),
          });
          if (!updated) return false;
          ops.recordOrphanPromote(ctx.repos, {
            runId,
            judgmentId: pair.judgmentId,
            sourceId: pair.sourceId,
            targetId: pair.targetId,
            relation: null,
            reasoning: text,
          });
          return true;
        });
        decision.verdict = changed ? 'drained' : 'not-pending';
        if (!changed) decision.reason = 'not-pending';
      } catch (err) {
        decision.verdict = 'write-failed';
        decision.reason = `write-failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (decision.verdict === 'drained') {
      result.drained += 1;
      if (action.kind === 'retired') result.drainedRetired += 1;
    } else if (decision.verdict === 'kept') {
      result.kept += 1;
      if (decision.reason.startsWith('fail-safe') || decision.reason.startsWith('kept:')) {
        result.keptUnknown += 1;
      } else result.keptAdmitted += 1;
    } else if (decision.verdict === 'not-pending') result.notPending += 1;
    else result.writeFailed += 1;
    result.decisions.push(decision);
  }
  ctx.repos.consolidation.finishRun(
    runId,
    new Date(),
    JSON.stringify({
      archives: 0,
      orphaned: 0,
      drain: {
        cursor: result.cursor,
        examined: result.examined,
        drainedRules: result.drained - result.drainedRetired,
        drainedRetired: result.drainedRetired,
        keptAdmitted: result.keptAdmitted,
        keptUnknown: result.keptUnknown,
      },
    }),
  );
  result.ms = performance.now() - t0;
  return result;
}

export interface SweepResult {
  ms: number;
  runs: RunResult[];
}

/** One sweep call (session start = 2 scopes, forced runAll = every project) sharing one budget (design D7). */
export function runSweep(
  ctx: DrainContext,
  projectIds: string[],
  opts: { cap: number; budgetMs: number; cursors: Map<string, string | null> },
): SweepResult {
  const t0 = performance.now();
  const deadlineAt = ctx.clock() + opts.budgetMs;
  const runs: RunResult[] = [];
  for (const projectId of projectIds) {
    const r = runDrain(ctx, {
      projectId,
      batch: opts.cap,
      cursor: opts.cursors.get(projectId) ?? null,
      deadlineAt,
    });
    opts.cursors.set(projectId, r.cursor);
    runs.push(r);
  }
  return { ms: performance.now() - t0, runs };
}

export interface PassResult {
  runs: RunResult[];
  decisions: Decision[];
  cursor: string | null;
}

/** Runs until every row pending at the start has been examined once (one full cursor cycle). */
export function drainOnePass(
  ctx: DrainContext,
  projectId: string,
  batch: number,
  opts: {
    cursor?: string | null;
    budgetMs?: number;
    mode?: 'full' | 'short';
    maxRuns?: number;
    amend?: Amendments;
  } = {},
): PassResult {
  const startSet = pendingIds(ctx.handle, projectId);
  const seen = new Set<string>();
  const runs: RunResult[] = [];
  const decisions: Decision[] = [];
  let cursor = opts.cursor ?? null;
  const maxRuns = opts.maxRuns ?? 100_000;
  while (runs.length < maxRuns) {
    const stillPending = new Set(pendingIds(ctx.handle, projectId));
    if (!startSet.some((id) => !seen.has(id) && stillPending.has(id))) break;
    const r = runDrain(ctx, {
      projectId,
      batch,
      cursor,
      ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
      mode: opts.mode ?? 'full',
      runIndex: runs.length + 1,
      ...(opts.amend ? { amend: opts.amend } : {}),
    });
    runs.push(r);
    cursor = r.cursor;
    for (const d of r.decisions) {
      if (!seen.has(d.judgmentId)) decisions.push(d);
      seen.add(d.judgmentId);
    }
    if (r.selected === 0) break;
  }
  return { runs, decisions, cursor };
}

// VERIFICATION READ (raw, read-only): pending judgment ids of one scope, in judgment_id order.
export function pendingIds(handle: any, projectId: string): string[] {
  return handle.raw
    .prepare(
      `SELECT r.judgment_id AS id FROM memory_relations r
       JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
       WHERE r.status = 'pending' AND ms.project_id = ? AND mt.project_id = ?
       ORDER BY r.judgment_id`,
    )
    .all(projectId, projectId)
    .map((r: any) => r.id as string);
}

// VERIFICATION READ (raw, read-only): every pending pair of one scope.
export function pendingPairs(handle: any, projectId: string): PendingRef[] {
  return handle.raw
    .prepare(
      `SELECT r.judgment_id AS judgmentId, r.source_id AS sourceId, r.target_id AS targetId
       FROM memory_relations r
       JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
       WHERE r.status = 'pending' AND ms.project_id = ? AND mt.project_id = ?
       ORDER BY r.judgment_id`,
    )
    .all(projectId, projectId);
}

// VERIFICATION READ (raw, read-only): a digest of the relation and journal tables.
export function stateDigest(handle: any): { relations: string; ops: string; runs: number } {
  const rel = handle.raw
    .prepare(
      `SELECT judgment_id, status, coalesce(relation,''), coalesce(reason,''), coalesce(marked_by_kind,''), coalesce(judged_at,'')
       FROM memory_relations ORDER BY judgment_id`,
    )
    .raw()
    .all();
  const op = handle.raw
    .prepare(
      `SELECT id, op_type, coalesce(created_id,''), coalesce(reasoning,''), coalesce(reverted_at,'')
       FROM consolidation_ops ORDER BY id`,
    )
    .raw()
    .all();
  const runs = handle.raw.prepare('SELECT count(*) AS n FROM consolidation_runs').get().n;
  return { relations: fnv(JSON.stringify(rel)), ops: fnv(JSON.stringify(op)), runs };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${s.length}`;
}

function independentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize('NFD').split(/[^\p{L}\p{N}\p{M}]+/u)) {
    const t = raw.replace(/\p{M}/gu, '').toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

function independentContainment(query: Set<string>, candidate: Set<string>): number {
  if (query.size === 0) return 0;
  let hits = 0;
  for (const t of query) if (candidate.has(t)) hits += 1;
  return hits / query.size;
}

function cosine64(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

export interface Verification {
  pairs: number;
  expectedDrained: number;
  expectedRetired: number;
  expectedKept: number;
  mismatches: string[];
  maxLexicalDelta: number;
  maxVectorDelta: number;
  nearVectorThreshold: number;
  nearLexicalFloor: number;
}

/**
 * Recomputes every v2 rule for every pair that was pending before the drain, through raw read-only
 * queries, an independent tokenizer and a float64 cosine, then checks the database state and the decision log.
 */
export function verifyDrain(
  handle: any,
  projectId: string,
  before: PendingRef[],
  decisions: Map<string, Decision>,
): Verification {
  const memStmt = handle.raw.prepare(
    'SELECT id, status, scope, project_id AS projectId, title, content FROM memory WHERE id = ?',
  );
  const vecStmt = handle.raw.prepare('SELECT embedding FROM memory_vec WHERE memory_id = ?');
  const entStmt = handle.raw.prepare(
    `SELECT e.kind || ':' || e.value AS k FROM memory_entity_links l
     JOIN memory_entities e ON e.id = l.entity_id WHERE l.memory_id = ?`,
  );
  const relStmt = handle.raw.prepare(
    'SELECT status, marked_by_kind AS markedByKind FROM memory_relations WHERE judgment_id = ?',
  );
  const opStmt = handle.raw.prepare(
    `SELECT reasoning, reverted_at AS revertedAt FROM consolidation_ops
     WHERE op_type = 'orphan_promote' AND created_id = ?`,
  );
  const vec = (id: string): Float32Array | undefined => {
    const row = vecStmt.get(id);
    if (!row) return undefined;
    const buf: Buffer = row.embedding;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const out: Verification = {
    pairs: before.length,
    expectedDrained: 0,
    expectedRetired: 0,
    expectedKept: 0,
    mismatches: [],
    maxLexicalDelta: 0,
    maxVectorDelta: 0,
    nearVectorThreshold: 0,
    nearLexicalFloor: 0,
  };
  for (const p of before) {
    const a = memStmt.get(p.sourceId);
    const b = memStmt.get(p.targetId);
    const d = decisions.get(p.judgmentId);
    let expect: 'keep' | 'stale' | 'retired' = 'keep';
    let why = '';
    if (!a || !b) why = 'endpoint missing';
    else if (a.projectId !== projectId || b.projectId !== projectId) why = 'out of scope';
    else if (a.status !== 'active' || b.status !== 'active') expect = 'retired';
    else {
      const lex = independentContainment(
        independentTerms(a.content),
        independentTerms(`${b.title}\n\n${b.content}`),
      );
      const va = vec(a.id);
      const vb = vec(b.id);
      const cos = va && vb ? Math.max(0, Math.min(1, cosine64(va, vb))) : undefined;
      const ea = new Set(entStmt.all(a.id).map((r: any) => r.k));
      const storedShared = entStmt.all(b.id).filter((r: any) => ea.has(r.k)).length;
      const xa = new Set(core.extractEntities(a.title, a.content).map(keyOf));
      const reShared = core
        .extractEntities(b.title, b.content)
        .filter((e: any) => xa.has(keyOf(e))).length;
      if (Math.abs(lex - LEXICAL_FLOOR) < 1e-9) out.nearLexicalFloor += 1;
      if (cos !== undefined && Math.abs(cos - VEC_THRESHOLD) < 1e-4) out.nearVectorThreshold += 1;
      if (d && d.check.lexical !== null)
        out.maxLexicalDelta = Math.max(out.maxLexicalDelta, Math.abs(d.check.lexical - lex));
      if (d && typeof d.check.vector === 'number' && cos !== undefined) {
        out.maxVectorDelta = Math.max(out.maxVectorDelta, Math.abs(d.check.vector - cos));
      }
      if (d && d.check.shared !== null && d.check.shared.length > 0 !== storedShared > 0) {
        out.mismatches.push(
          `${p.judgmentId}: stored-entity channel disagrees with the recomputation`,
        );
      }
      const admitted =
        lex >= LEXICAL_FLOOR ||
        (cos !== undefined && cos >= VEC_THRESHOLD) ||
        storedShared > 0 ||
        reShared > 0;
      if (admitted) why = 'admitted';
      else if (cos === undefined) why = 'vector unknown';
      else expect = 'stale';
    }
    if (expect === 'keep') out.expectedKept += 1;
    else if (expect === 'stale') out.expectedDrained += 1;
    else out.expectedRetired += 1;
    const rel = relStmt.get(p.judgmentId);
    const live = opStmt.all(p.judgmentId).filter((o: any) => o.revertedAt === null);
    const staleOps = live.filter((o: any) =>
      String(o.reasoning).startsWith(`orphaned: ${STALE_PREFIX}:`),
    ).length;
    const retiredOps = live.filter((o: any) =>
      String(o.reasoning).startsWith(`orphaned: ${RETIRED_PREFIX}:`),
    ).length;
    if (expect === 'keep') {
      if (rel?.status !== 'pending')
        out.mismatches.push(`${p.judgmentId}: expected kept (${why}), relation is ${rel?.status}`);
      if (staleOps + retiredOps !== 0)
        out.mismatches.push(`${p.judgmentId}: expected kept (${why}), found a drain op`);
    } else {
      if (rel?.status !== 'orphaned' || rel?.markedByKind !== 'consolidator') {
        out.mismatches.push(
          `${p.judgmentId}: expected ${expect} drain, relation is ${rel?.status}`,
        );
      }
      const want = expect === 'stale' ? [staleOps, retiredOps] : [retiredOps, staleOps];
      if (want[0] !== 1 || want[1] !== 0) {
        out.mismatches.push(
          `${p.judgmentId}: expected one ${expect} op, found stale ${staleOps} retired ${retiredOps}`,
        );
      }
    }
    if (!d) out.mismatches.push(`${p.judgmentId}: no decision logged`);
    else {
      const logged =
        d.verdict === 'drained' ? (d.reason === 'drained:retired' ? 'retired' : 'stale') : 'keep';
      if (logged !== expect) {
        out.mismatches.push(
          `${p.judgmentId}: decision log says ${d.verdict}/${d.reason}, recomputation says ${expect}${why ? ` (${why})` : ''}`,
        );
      }
    }
  }
  return out;
}

export function memoized(embedder: any): any {
  const cache = new Map<string, Promise<Float32Array>>();
  return {
    modelId: embedder.modelId,
    embed(text: string) {
      const hit = cache.get(text);
      if (hit) return hit;
      const next = embedder.embed(text);
      cache.set(text, next);
      return next;
    },
  };
}

export function throwingEmbedder(): { embedder: any; calls: () => number } {
  let calls = 0;
  return {
    embedder: {
      modelId: 'spy-that-throws',
      embed(): Promise<Float32Array> {
        calls += 1;
        throw new Error('the drain called the embedding model');
      },
    },
    calls: () => calls,
  };
}

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export function pad(v: unknown, n: number): string {
  return String(v).padStart(n);
}
