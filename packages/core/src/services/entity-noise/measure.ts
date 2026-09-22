import {
  memory,
  MemoryRepository,
  projectScope,
  ProjectsRepository,
  type EntityKind,
} from '@rembric/db';
import { ulid } from 'ulid';

import { sanitizeFtsQuery } from '@rembric/core';

import { createTestDb } from '../../test-support/db.js';

import { NOISE_PROBES, type NoiseProbe } from './corpus.js';

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
