import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import type { MemoryScope, MemoryStatus, MemoryType } from '../schema/memory.js';

import { partitionKeyFor } from './scope-clause.js';

export interface VecNeighbor {
  id: string;
  distance: number;
  title: string;
  content: string;
  topicKey: string | null;
}

export interface KnnOpts {
  memoryId: string;
  scope: MemoryScope;
  projectId: string | null;
  excludeIds: string[];
  limit: number;
}

/** A memory still missing an embedding, with the metadata the vec row needs. */
export interface PendingEmbedding {
  id: string;
  title: string;
  content: string;
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type: MemoryType;
}

export interface QueryVectorKnnOpts {
  queryVector: Float32Array;
  partitionKey: string;
  /** Archived rows are outside the post-model-change semantic guarantee. */
  status: Exclude<MemoryStatus, 'archived'>;
  type?: MemoryType;
  /** Bounded over-fetch depth (Elastic's rank_window_size). */
  rankWindowSize: number;
}

export class VectorsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Cosine-distance kNN over active rows in the query row's scope shard,
   * excluding the query row and any ids already linked to it. Empty when
   * the query row has no embedding yet. Save-time candidate detection only.
   *
   * Two-step: fetch the row's embedding, then reuse the partition-pruned
   * `knnByQueryVector` with `k = limit + |excludeIds| + 1` (the over-fetch
   * keeps result cardinality after dropping self + excluded ids). The L2
   * kNN order equals cosine order because embeddings are unit-normalized
   * (embedder `normalize: true`); the hydration recomputes exact cosine
   * distances so returned values match the pre-pruning implementation.
   */
  knnCandidates(opts: KnnOpts): VecNeighbor[] {
    const queryVector = this.findEmbedding(opts.memoryId);
    if (!queryVector) return [];
    const neighbors = this.knnByQueryVector({
      queryVector,
      partitionKey: partitionKeyFor(opts.scope, opts.projectId),
      status: 'active',
      rankWindowSize: opts.limit + opts.excludeIds.length + 1,
    });
    const excluded = new Set([opts.memoryId, ...opts.excludeIds]);
    const ids = neighbors
      .filter((n) => !excluded.has(n.id))
      .slice(0, opts.limit)
      .map((n) => n.id);
    if (ids.length === 0) return [];
    const embedding = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );
    return this.db.all<VecNeighbor>(
      sql`
        SELECT m.id AS id,
               vec_distance_cosine(${embedding}, v.embedding) AS distance,
               m.title AS title,
               m.content AS content,
               m.topic_key AS topicKey
        FROM json_each(${JSON.stringify(ids)}) je
          JOIN memory_vec v ON v.memory_id = je.value
          JOIN memory m ON m.id = je.value
        ORDER BY distance ASC
      `,
    );
  }

  private findEmbedding(memoryId: string): Float32Array | undefined {
    const row = this.db.get<{ embedding: Buffer }>(
      sql`SELECT embedding FROM memory_vec WHERE memory_id = ${memoryId}`,
    ) as { embedding: Buffer } | undefined;
    if (!row) return undefined;
    return new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
  }

  /**
   * kNN over an arbitrary query vector, pre-filtered inside the vector index
   * by partition key (scope shard), `status`, and optional `type`. Powers the
   * `memory.search` dense branch. Uses sqlite-vec's `MATCH … AND k = ?` form
   * (k, not LIMIT) so the partition shard is scanned, not the whole corpus.
   */
  knnByQueryVector(opts: QueryVectorKnnOpts): { id: string; distance: number }[] {
    const embedding = Buffer.from(
      opts.queryVector.buffer,
      opts.queryVector.byteOffset,
      opts.queryVector.byteLength,
    );
    const typeClause = opts.type ? sql`AND type = ${opts.type}` : sql``;
    return this.db.all<{ id: string; distance: number }>(
      sql`
        SELECT memory_id AS id, distance
        FROM memory_vec
        WHERE embedding MATCH ${embedding}
          AND k = ${opts.rankWindowSize}
          AND partition_key = ${opts.partitionKey}
          AND status = ${opts.status}
          ${typeClause}
        ORDER BY distance
      `,
    );
  }

  count(): number {
    const row = this.db.get<{ v: number }>(sql`SELECT count(*) AS v FROM memory_vec`) as
      | { v: number }
      | undefined;
    return row?.v ?? 0;
  }

  /**
   * status/type are read from `memory` in this same statement rather than
   * accepted as parameters, so a status change racing an in-flight embed
   * (e.g. a topic_key supersede) can never be written stale.
   */
  insertEmbedding(memoryId: string, embedding: Buffer, partitionKey: string): void {
    this.db.run(
      sql`INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
          SELECT ${memoryId}, ${partitionKey}, m.status, m.type, ${embedding}
          FROM memory m WHERE m.id = ${memoryId}`,
    );
  }

  /** Non-archived memories missing an embedding, oldest first. */
  findMissingEmbeddings(limit: number): PendingEmbedding[] {
    return this.db.all<PendingEmbedding>(sql`
      SELECT m.id AS id, m.title AS title, m.content AS content, m.scope AS scope,
             m.project_id AS projectId, m.status AS status, m.type AS type
      FROM memory m
      LEFT JOIN memory_vec v ON v.memory_id = m.id
      WHERE v.memory_id IS NULL
        AND m.status != 'archived'
      ORDER BY m.created_at ASC
      LIMIT ${limit}
    `);
  }

  /**
   * Unscoped — `admin`-prefixed so the confinement gate covers it, matching
   * `entities.adminBacklogCount()`. Reachable from `memory.doctor`, whose
   * report is deliberately server-wide.
   *
   * The anti-join, not `count(memory) - count(memory_vec)`: `memory_vec` is the
   * one derived child of `memory` with no foreign key, so an orphaned vec row
   * and a genuinely pending memory cancel to exactly zero.
   */
  adminBacklogCount(): number {
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v FROM memory m
      LEFT JOIN memory_vec v ON v.memory_id = m.id
      WHERE v.memory_id IS NULL AND m.status != 'archived'
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  deleteAll(): void {
    this.db.run(sql`DELETE FROM memory_vec`);
  }
}
