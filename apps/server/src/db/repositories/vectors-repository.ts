import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import type { MemoryScope, MemoryStatus, MemoryType } from '../schema/memory.js';

import { scopeWhere } from './scope-clause.js';

export interface VecNeighbor {
  id: string;
  distance: number;
  title: string;
  content: string;
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
   * Cosine-distance kNN over `memory_vec` for active in-scope rows,
   * excluding the query row and any ids already linked to it. Empty when
   * the query row has no embedding yet. Save-time candidate detection only.
   */
  knnByCosine(opts: KnnOpts): VecNeighbor[] {
    return this.db.all<VecNeighbor>(
      sql`
        SELECT m.id AS id,
               vec_distance_cosine(v_self.embedding, v_other.embedding) AS distance,
               m.title AS title,
               m.content AS content
        FROM memory_vec v_self
          JOIN memory_vec v_other ON v_other.memory_id != v_self.memory_id
          JOIN memory m ON m.id = v_other.memory_id
        WHERE v_self.memory_id = ${opts.memoryId}
          AND ${scopeWhere(opts.scope, opts.projectId, 'm')}
          AND m.status = 'active'
          AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeIds)}))
        ORDER BY distance ASC
        LIMIT ${opts.limit}
      `,
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

  insertEmbedding(
    memoryId: string,
    embedding: Buffer,
    partitionKey: string,
    status: MemoryStatus,
    type: MemoryType,
  ): void {
    this.db.run(
      sql`INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
          VALUES (${memoryId}, ${partitionKey}, ${status}, ${type}, ${embedding})`,
    );
  }

  /** Non-archived memories still missing an embedding, oldest first. */
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

  backlogCount(): number {
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

  /**
   * Nearest-neighbor cosine similarity sample for calibration telemetry.
   * Scoped to `active` memories so the VEC_THRESHOLD reference is not skewed
   * by retained superseded/archived (or post-model-change stale-space) vectors.
   */
  similaritySample(sample: number): { memoryId: string; sim: number }[] {
    return this.db.all<{ memoryId: string; sim: number }>(sql`
      SELECT v_self.memory_id AS memoryId,
             1 - MIN(vec_distance_cosine(v_self.embedding, v_other.embedding)) AS sim
      FROM memory_vec v_self
        JOIN memory m_self ON m_self.id = v_self.memory_id AND m_self.status = 'active'
        JOIN memory_vec v_other ON v_other.memory_id != v_self.memory_id
        JOIN memory m_other ON m_other.id = v_other.memory_id AND m_other.status = 'active'
      GROUP BY v_self.memory_id
      ORDER BY v_self.memory_id DESC
      LIMIT ${sample}
    `);
  }
}
