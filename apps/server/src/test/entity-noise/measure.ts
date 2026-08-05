import { ulid } from 'ulid';

import { MemoryRepository } from '../../db/repositories/memory-repository.js';
import { ProjectsRepository } from '../../db/repositories/projects-repository.js';
import type { EntityKind } from '../../db/schema/entities.js';
import { memory } from '../../db/schema/memory.js';
import { sanitizeFtsQuery } from '../../services/hybrid-search.js';
import { projectScope } from '../../services/scope.js';
import { createTestDb } from '../db.js';

import { NOISE_PROBES, type NoiseProbe } from './corpus.js';

/**
 * Measures each entity kind's lexical false-positive rate through the REAL
 * retrieval path — `sanitizeFtsQuery` into the production `searchBm25Ids` over
 * a live FTS5 index — rather than reasoning about the tokenizer on paper.
 *
 * Each probe gets its own throwaway database: the question is how noisy a
 * lookup is against its OWN near-misses, so one probe's decoys must not
 * inflate another's figure.
 */

export interface ProbeResult {
  probe: NoiseProbe;
  /** True when the lexical branch returned the document that genuinely references the identifier. */
  truthMatched: boolean;
  matchedDecoys: number;
  totalMatches: number;
  /** Fraction of returned documents that are not about the identifier. */
  noiseRate: number;
}

export interface KindNoise {
  /** `probe.family` when the kind is split, otherwise the kind itself. */
  group: string;
  kind: EntityKind;
  probes: number;
  /**
   * Worst per-probe rate in the group. Worst case, not the mean: the corpus is
   * adversarial, and a mean would let a benign probe dilute a real collision
   * (a path in a different directory measures 0% while a `.bak` sibling
   * measures 67% — reporting 33% would describe neither).
   */
  noiseRate: number;
  results: ProbeResult[];
}

function runProbe(probe: NoiseProbe): ProbeResult {
  const t = createTestDb();
  try {
    const repo = new MemoryRepository(t.handle.db);
    const projectId = new ProjectsRepository(t.handle.db).findDefault()!.id;
    const truthId = ulid();
    const rows = [
      { id: truthId, content: probe.truth },
      ...probe.decoys.map((d) => ({ id: ulid(), content: d.text })),
    ];
    t.handle.db
      .insert(memory)
      .values(
        rows.map((r) => ({
          id: r.id,
          scope: 'project' as const,
          projectId,
          type: 'reference' as const,
          title: r.content.slice(0, 100),
          content: r.content,
          tags: [],
          status: 'active' as const,
          replaces: [],
          createdAt: new Date(1_000),
          lastSeenAt: new Date(1_000),
        })),
      )
      .run();

    const matchExpr = sanitizeFtsQuery(probe.identifier);
    const hits = matchExpr
      ? repo.searchBm25Ids({
          matchExpr,
          scope: projectScope(projectId),
          status: 'active',
          limit: rows.length + 1,
        })
      : [];
    const matchedIds = new Set(hits.map((h) => h.id));
    const truthMatched = matchedIds.has(truthId);
    const matchedDecoys = [...matchedIds].filter((id) => id !== truthId).length;
    const totalMatches = matchedIds.size;
    return {
      probe,
      truthMatched,
      matchedDecoys,
      totalMatches,
      noiseRate: totalMatches === 0 ? 0 : matchedDecoys / totalMatches,
    };
  } finally {
    t.cleanup();
  }
}

export function measureLexicalNoise(): KindNoise[] {
  const byGroup = new Map<string, ProbeResult[]>();
  for (const probe of NOISE_PROBES) {
    const group = probe.family ?? probe.kind;
    const list = byGroup.get(group) ?? [];
    list.push(runProbe(probe));
    byGroup.set(group, list);
  }
  return [...byGroup].map(([group, results]) => ({
    group,
    kind: results[0]!.probe.kind,
    probes: results.length,
    noiseRate: Math.max(...results.map((r) => r.noiseRate)),
    results,
  }));
}

/** Percentage, rounded to whole points — the grid the spec's table is written on. */
export function noisePercent(rate: number): number {
  return Math.round(rate * 100);
}
