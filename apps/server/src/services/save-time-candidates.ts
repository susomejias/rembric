import type { Repositories } from '../db/repositories/index.js';
import type { Memory } from '../db/schema/memory.js';

import type { ExtractedEntity } from './entities.js';
import { sanitizeFtsQuery, tokenContainment, tokenSet } from './hybrid-search.js';

/**
 * How far back through the new row's `replaces` ancestry save-time detection
 * looks for `not_conflict` dismissals to suppress.
 *
 * Its own constant, not `memory.get`'s `PREDECESSOR_CAP`, even though both are 10
 * today. That constant's docstring justifies 10 as a TOKEN BUDGET for a response
 * payload; borrowing it coupled two unrelated decisions, so raising the payload
 * budget to show 25 predecessors would have silently deepened suppression, and
 * trimming it to 5 would have silently lost dismissals an agent already made.
 * Neither can move the other now without a spec change.
 */
export const DISMISSAL_ANCESTRY_CAP = 10;

/**
 * Save-time candidate detector for `memory.save`.
 *
 * Runs three passes, deduplicates by target id, ranks by the single
 * similarity quantity every pass reports, returns the top N.
 *
 *   1. Vec kNN (when an embedding for the just-saved row already
 *      exists; otherwise this pass is a no-op for THIS save and the
 *      FTS pass below picks up the slack).
 *   2. FTS5 BM25 query against the row's content.
 *   3. Entity overlap — rarity-gated, and it leads the merged list.
 *
 * Scope isolation: the SQL filters by `(scope, project_id)` matching
 * the just-saved row. Rows already linked to it via `replaces` are
 * excluded.
 *
 * The detector NEVER inserts rows — it only proposes pairs. The caller
 * (in `MemoryService.save`) decides which to surface to the agent and
 * which to leave to the consolidator.
 */

/**
 * Vec similarity floor is an engine constant calibrated for the compiled-in
 * embedding model (gte-multilingual-base q8) — not operator configuration.
 * Sandbox-calibrated on a 16-pair battery (positives 0.73–0.97, negatives
 * 0.43–0.68); revisit against backfill distribution logs.
 *
 * The lexical side has no equivalent absolute floor: FTS5's raw bm25 is
 * unbounded and scales with corpus size and term IDF, so no fixed threshold
 * over it is stable (see fix-retrieval-ranking-math). Lexical admission is
 * by rank position within the already bm25-ordered pool instead — the SQL
 * `ORDER BY rank LIMIT poolSize` in `searchBm25Candidates` IS the admission
 * rule; there is no separate gate.
 */
export const VEC_THRESHOLD = 0.7;

/**
 * Rarity gate for the entity candidate channel (design.md Decision 6): an
 * entity linked to more than this proportion of the scope's active
 * memories carries no signal — every memory in a small project might
 * mention the project's own package name — and would otherwise flood the
 * per-save budget with noise, starving the lexical/dense channels. A
 * proportion, not an absolute count, so it adapts to corpus size (the same
 * lesson the inverted BM25 threshold taught: absolute thresholds over
 * corpus-relative quantities don't hold).
 *
 * It is an ADMISSION gate and never a score. Reporting `1 - linkCount /
 * scopeMemoryCount` as `similarity` made a once-linked entity in a
 * 1000-memory scope report 0.999 and outrank any realistic cosine in a merge
 * that claims to compare one quantity — a rarity proportion dressed as a
 * similarity, and corpus-size dependent besides.
 */
export const ENTITY_RARITY_THRESHOLD = 0.15;

/**
 * Link count below which the rarity gate does not apply at all.
 *
 * Derived ONCE, at authoring time, from `CANDIDATES_PER_SAVE_MAX_DEFAULT`: the
 * gate exists so a ubiquitous entity cannot occupy the whole per-save budget, and
 * an entity linked to fewer memories than that budget holds cannot occupy it. So
 * blocking it serves nothing the requirement names.
 *
 * Deliberately NOT read from the operator setting. `CANDIDATES_PER_SAVE_MAX` is
 * environment-configurable and may be `0`; reading it here would make an
 * ADMISSION rule environment-settable — the same reason `CANDIDATE_POOL_SIZE` is
 * not exposed — and at `0` would invert the gate into always-applies. The
 * coupling is a documented derivation, not a dependency.
 */
export const ENTITY_RARITY_MIN_LINKS = 5;

/**
 * The per-channel pool each detection channel scans BEFORE the merged list is
 * ranked and capped. Applied per channel, and once per extracted entity on the
 * entity channel, so the merged pool — and therefore `detected` — MAY exceed it.
 * Not operator-configurable: for the lexical channel it IS the admission rule,
 * so exposing it would make an admission rule environment-settable.
 */
export const CANDIDATE_POOL_SIZE = 20;

export interface CandidateOptions {
  perSaveMax: number;
  /** Test seam only — never read from the environment. */
  poolSize?: number;
}

export interface SaveCandidate {
  targetId: string;
  /**
   * 0..1, normalized, and the SAME quantity whichever channel reported it:
   * cosine for `vec`, query-token containment for `fts` and `entity`. An
   * entity match routinely shares no vocabulary with the saved row, so a low
   * value here is expected and is not a weak match — `source`/`entityValue`
   * carry that evidence, and the ordering below carries its precedence.
   */
  similarity: number;
  /** Which detector surfaced this match. */
  source: 'vec' | 'fts' | 'entity';
  title: string;
  snippet: string;
  topicKey: string | null;
  /** Set only for `source: 'entity'` — the value both memories share. */
  entityValue?: string;
}

export interface SaveCandidateResult {
  /** The first `perSaveMax` of the same ranked order `detected` was counted over. */
  candidates: SaveCandidate[];
  /**
   * Distinct pairs the ranking saw before the cap. A LOWER BOUND on how many
   * memories in scope resemble the saved row, never a scope total: each channel
   * scanned at most `CANDIDATE_POOL_SIZE` rows before ranking.
   */
  detected: number;
}

export function findSaveTimeCandidates(
  repos: Pick<Repositories, 'memory' | 'vectors' | 'relations' | 'entities'>,
  saved: Memory,
  opts: CandidateOptions,
  extractedEntities: ExtractedEntity[] = [],
): SaveCandidateResult {
  const poolSize = opts.poolSize ?? CANDIDATE_POOL_SIZE;
  // Candidate detection is a scoped read, and a row with no project is in no
  // scope. Unreachable for anything this image wrote; possible for a row an
  // older one left behind.
  const projectId = saved.projectId;
  if (projectId === null) return { candidates: [], detected: 0 };

  // Suppress targets the new memory's ancestry already judged `not_conflict`,
  // so a re-save never re-surfaces an already-dismissed pair. `saved.replaces`
  // alone is one hop — `saveWithTopicKey` sets a single predecessor — which
  // loses a dismissal made two or more saves back on the same topic.
  const ancestorIds = repos.memory.unsafeAncestorIds({
    startIds: saved.replaces,
    limit: DISMISSAL_ANCESTRY_CAP,
  });
  const dismissedIds =
    ancestorIds.length > 0 ? repos.relations.listNotConflictTargetsForSources(ancestorIds) : [];
  const excludeIds = [...saved.replaces, ...dismissedIds];

  // Vec kNN is only useful once the just-saved row has an embedding (the
  // worker may not have processed it yet); otherwise the FTS pass below
  // picks up the slack.
  const vecRows = repos.vectors.knnCandidates({
    memoryId: saved.id,
    projectId,
    excludeIds,
    limit: poolSize,
  });
  const vecPool: SaveCandidate[] = vecRows
    .map((r) => ({
      targetId: r.id,
      similarity: 1 - Math.max(0, Math.min(1, r.distance)),
      source: 'vec' as const,
      title: r.title,
      snippet: snippet(r.content, 200),
      topicKey: r.topicKey,
    }))
    .filter((c) => c.similarity >= VEC_THRESHOLD);

  // Admission is by rank position: the query already orders by bm25 best-
  // first and LIMITs to poolSize, so every returned row is admitted. The
  // REPORTED similarity is a separate concern — bounded token containment
  // over the sanitized token set, truthful against its documented `0..1`
  // range and comparable to cosine. The entity pass reports the same quantity,
  // so the merge below compares one thing rather than three.
  const queryTokens = tokenSet(saved.content);
  const matchExpr = sanitizeFtsQuery(saved.content, { maxTerms: 16 });
  const ftsPool: SaveCandidate[] = [];
  if (matchExpr.length > 0) {
    const ftsRows = repos.memory.searchBm25Candidates({
      matchExpr,
      excludeId: saved.id,
      projectId,
      excludeIds,
      limit: poolSize,
    });
    for (const r of ftsRows) {
      ftsPool.push({
        targetId: r.id,
        similarity: tokenContainment(queryTokens, tokenSet(`${r.title}\n\n${r.content}`)),
        source: 'fts',
        title: r.title,
        snippet: snippet(r.content, 200),
        topicKey: r.topicKey,
      });
    }
  }

  // Entity overlap: a candidate source neither text nor vector similarity
  // can reach — two memories about the same file/error code can share
  // almost no vocabulary and sit far apart in embedding space. Gated by
  // rarity (see `ENTITY_RARITY_THRESHOLD`): a common entity generates no
  // candidates at all, never a low-scoring one. Rarity gates admission; the
  // reported similarity is the lexical-containment quantity, same as the pass above.
  const entityPool: SaveCandidate[] = [];
  if (extractedEntities.length > 0) {
    const excludeIdSet = new Set(excludeIds);
    // Depends only on (scope, projectId) — computed once per save, not once
    // per extracted entity. `excludeMemoryId` guards against self-inflation
    // structurally even though the caller already sequences linking after
    // candidate detection (see `saveMemoryWithCandidates`).
    const scopeMemoryCount = repos.entities.scopeActiveMemoryCount({
      projectId,
      excludeMemoryId: saved.id,
    });

    for (const e of extractedEntities) {
      if (scopeMemoryCount === 0) continue;
      const linkCount = repos.entities.entityLinkCount({
        projectId,
        kind: e.kind,
        value: e.value,
        excludeMemoryId: saved.id,
      });
      // `>=`, so an entity AT the floor is still gated: the exemption is for
      // entities too sparse to occupy the budget, not for small scopes. Without it
      // the proportion form blocks a single-link entity outright on a young scope
      // (`1/2 = 0.50`), which is the convergence case the channel exists for.
      if (
        linkCount >= ENTITY_RARITY_MIN_LINKS &&
        linkCount / scopeMemoryCount > ENTITY_RARITY_THRESHOLD
      )
        continue;

      const rows = repos.entities.findOtherMemoriesForEntity({
        projectId,
        kind: e.kind,
        value: e.value,
        excludeMemoryId: saved.id,
        excludeIds,
        limit: poolSize,
      });
      for (const r of rows) {
        if (excludeIdSet.has(r.id)) continue;
        entityPool.push({
          targetId: r.id,
          similarity: tokenContainment(queryTokens, tokenSet(`${r.title}\n\n${r.content}`)),
          source: 'entity',
          title: r.title,
          snippet: snippet(r.content, 200),
          topicKey: r.topicKey,
          entityValue: e.value,
        });
      }
    }
  }

  // For each unique target id keep the higher-scoring source (vec wins ties
  // because vec is semantic and fts is lexical), except that an entity row
  // always survives: only it carries `entityValue`, the exact address that
  // explains why the pair was proposed at all.
  const byId = new Map<string, SaveCandidate>();
  for (const c of [...vecPool, ...ftsPool, ...entityPool]) {
    const prev = byId.get(c.targetId);
    if (!prev) {
      byId.set(c.targetId, c);
    } else if (
      prev.source !== 'entity' &&
      (c.source === 'entity' || c.similarity > prev.similarity)
    ) {
      byId.set(c.targetId, c);
    }
  }
  // Entity candidates lead. Precedence is explicit here rather than smuggled in
  // through an inflated score, and it is not optional: a shared rare identifier
  // with near-zero vocabulary overlap is the case the channel exists for, so
  // ranking on `similarity` alone would push it past `perSaveMax` behind
  // candidates the other two channels would have found anyway.
  const all = [...byId.values()].sort(
    (a, b) =>
      Number(b.source === 'entity') - Number(a.source === 'entity') || b.similarity - a.similarity,
  );
  return { candidates: all.slice(0, opts.perSaveMax), detected: all.length };
}

function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}
