import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import type { MemoryScope } from '../schema/memory.js';

export interface VecNeighbor {
  id: string;
  distance: number;
  content: string;
}

export interface KnnOpts {
  memoryId: string;
  scope: MemoryScope;
  projectId: string | null;
  excludeIds: string[];
  limit: number;
}

export class VectorsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Cosine-distance kNN over `memory_vec` for active in-scope rows,
   * excluding the query row and any ids already linked to it. Empty when
   * the query row has no embedding yet.
   */
  knnByCosine(opts: KnnOpts): VecNeighbor[] {
    const scopeWhere =
      opts.scope === 'project'
        ? sql`scope = 'project' AND project_id = ${opts.projectId}`
        : sql`scope = 'global' AND project_id IS NULL`;
    return this.db.all<VecNeighbor>(
      sql`
        SELECT m.id AS id,
               vec_distance_cosine(v_self.embedding, v_other.embedding) AS distance,
               m.content AS content
        FROM memory_vec v_self
          JOIN memory_vec v_other ON v_other.memory_id != v_self.memory_id
          JOIN memory m ON m.id = v_other.memory_id
        WHERE v_self.memory_id = ${opts.memoryId}
          AND ${scopeWhere}
          AND m.status = 'active'
          AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeIds)}))
        ORDER BY distance ASC
        LIMIT ${opts.limit}
      `,
    );
  }

  count(): number {
    const row = this.db.get<{ v: number }>(sql`SELECT count(*) AS v FROM memory_vec`) as
      | { v: number }
      | undefined;
    return row?.v ?? 0;
  }

  insertEmbedding(memoryId: string, embedding: Buffer): void {
    this.db.run(
      sql`INSERT INTO memory_vec (memory_id, embedding) VALUES (${memoryId}, ${embedding})`,
    );
  }

  /** Non-archived memories still missing an embedding, oldest first. */
  findMissingEmbeddings(limit: number): { id: string; content: string }[] {
    return this.db.all<{ id: string; content: string }>(sql`
      SELECT m.id AS id, m.content AS content
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

  /** Nearest-neighbor cosine similarity sample for calibration telemetry. */
  similaritySample(sample: number): { memoryId: string; sim: number }[] {
    return this.db.all<{ memoryId: string; sim: number }>(sql`
      SELECT v_self.memory_id AS memoryId,
             1 - MIN(vec_distance_cosine(v_self.embedding, v_other.embedding)) AS sim
      FROM memory_vec v_self
        JOIN memory_vec v_other ON v_other.memory_id != v_self.memory_id
      GROUP BY v_self.memory_id
      ORDER BY v_self.memory_id DESC
      LIMIT ${sample}
    `);
  }
}
