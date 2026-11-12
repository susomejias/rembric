import { createRepositories, projectScope, type Scope } from '@rembric/db';

import type { Embedder } from '../../embeddings/embedder.js';
import { EmbeddingWorker } from '../../services/embedding-worker.js';
import { MemoryService } from '../../services/memory.js';
import { ProjectsService } from '../../services/projects.js';
import { RelationsService } from '../../services/relations.js';
import { runPostSaveSteps, type SaveTimeCandidateView } from '../../services/save-curation.js';
import { TestClock } from '../clock.js';
import { createTestDb } from '../db.js';

import {
  type LabelledSave,
  SAVE_TIME_BASE,
  SAVE_TIME_SAVES,
  type SaveTimeBaseItem,
  type SaveTimeClass,
} from './save-time-fixture.js';

export const SAVE_TIME_PER_SAVE_MAX = 5;

export const SAVE_TIME_FLOORS: readonly number[] = Array.from({ length: 20 }, (_, i) => i / 20);

export const MIN_PLATEAU_WIDTH = 0.1;

export type CandidateSource = SaveTimeCandidateView['source'];
export type SweepArm = 'lexical-only' | 'production';
export type LabelledClass = Exclude<SaveTimeClass, 'unrelated'>;

const LABELLED_CLASSES: readonly LabelledClass[] = [
  'near-duplicate',
  'expanded-rewrite',
  'contradiction',
];
const SOURCES: readonly CandidateSource[] = ['fts', 'vec', 'entity'];
const MINUTE_MS = 60_000;

export interface SaveOutcome {
  id: string;
  class: SaveTimeClass;
  surfacedExpected: boolean | null;
  sources: CandidateSource[];
}

export interface Fixture {
  base: readonly SaveTimeBaseItem[];
  saves: readonly LabelledSave[];
}

export async function runSaveTimeArm(
  embedder: Embedder | null,
  floor: number,
  fixture: Fixture = { base: SAVE_TIME_BASE, saves: SAVE_TIME_SAVES },
): Promise<SaveOutcome[]> {
  const { handle, cleanup } = createTestDb();
  try {
    const repos = createRepositories(handle.db);
    const project = new ProjectsService(repos).create({
      slug: 'save-time',
      displayName: 'Save-time fixture',
    });
    const scope: Scope = projectScope(project.id);
    const clock = new TestClock();
    const memory = new MemoryService(repos, handle.db, clock.now);
    const relations = new RelationsService(repos, handle.db, clock.now);
    const worker = embedder ? new EmbeddingWorker({ repos, embedder }) : null;
    const deps = {
      relations,
      repos,
      candidates: { perSaveMax: SAVE_TIME_PER_SAVE_MAX, lexicalFloor: floor },
      ...(worker
        ? {
            embedNow: (id: string, title: string, content: string, projectId: string) =>
              worker.embedNow(id, title, content, projectId),
          }
        : {}),
    };

    const idByFixtureId = new Map<string, string>();
    const save = async (item: SaveTimeBaseItem): Promise<SaveTimeCandidateView[]> => {
      clock.set(new Date(clock.now().getTime() + MINUTE_MS));
      const { memory: saved } = memory.saveWithTopicKey(
        { type: item.type, title: item.title, content: item.content },
        scope,
      );
      idByFixtureId.set(item.id, saved.id);
      const { candidates } = await runPostSaveSteps(deps, saved, scope);
      return candidates;
    };

    for (const item of fixture.base) await save(item);

    const outcomes: SaveOutcome[] = [];
    for (const item of fixture.saves) {
      const candidates = await save(item);
      const expectedId = item.expects ? idByFixtureId.get(item.expects) : undefined;
      if (item.expects && !expectedId) {
        throw new Error(`save '${item.id}' expects unknown base item '${item.expects}'`);
      }
      outcomes.push({
        id: item.id,
        class: item.class,
        surfacedExpected: expectedId ? candidates.some((c) => c.targetId === expectedId) : null,
        sources: candidates.map((c) => c.source).sort(),
      });
    }
    return outcomes;
  } finally {
    cleanup();
  }
}

export interface PointSummary {
  floor: number;
  surfaced: Record<LabelledClass, { hit: number; total: number }>;
  unrelatedSaves: number;
  unrelatedRowsBySource: Record<CandidateSource, number>;
  totalRows: number;
}

export function summarize(floor: number, outcomes: readonly SaveOutcome[]): PointSummary {
  const surfaced = Object.fromEntries(
    LABELLED_CLASSES.map((cls) => {
      const of = outcomes.filter((o) => o.class === cls);
      return [cls, { hit: of.filter((o) => o.surfacedExpected).length, total: of.length }];
    }),
  ) as Record<LabelledClass, { hit: number; total: number }>;
  const unrelated = outcomes.filter((o) => o.class === 'unrelated');
  const unrelatedRowsBySource = Object.fromEntries(
    SOURCES.map((s) => [
      s,
      unrelated.reduce((n, o) => n + o.sources.filter((x) => x === s).length, 0),
    ]),
  ) as Record<CandidateSource, number>;
  return {
    floor,
    surfaced,
    unrelatedSaves: unrelated.length,
    unrelatedRowsBySource,
    totalRows: outcomes.reduce((n, o) => n + o.sources.length, 0),
  };
}

export function admissible(arm: SweepArm, s: PointSummary): boolean {
  if (s.unrelatedRowsBySource.fts !== 0) return false;
  const required: readonly LabelledClass[] =
    arm === 'lexical-only' ? ['near-duplicate'] : LABELLED_CLASSES;
  return required.every((cls) => s.surfaced[cls].hit === s.surfaced[cls].total);
}

export interface Plateau {
  from: number;
  to: number;
  width: number;
  chosen: number;
}

export function widestPlateau(floors: readonly number[], ok: readonly boolean[]): Plateau | null {
  let best: Plateau | null = null;
  let start = -1;
  for (let i = 0; i <= floors.length; i++) {
    if (i < floors.length && ok[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const from = floors[start]!;
      const to = floors[i - 1]!;
      const width = round2(to - from);
      if (!best || width > best.width) {
        best = { from, to, width, chosen: floors[start + Math.floor((i - 1 - start) / 2)]! };
      }
      start = -1;
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rate(r: { hit: number; total: number }): string {
  return `${r.hit}/${r.total}`;
}

export function formatArm(arm: SweepArm, points: readonly PointSummary[]): string[] {
  const head = [
    'floor',
    'near-dup',
    'expanded',
    'contradict',
    'unrel fts/save',
    'unrel vec/save',
    'unrel ent/save',
    'queue depth',
    'admissible',
  ];
  const lines = [
    `## arm: ${arm} (instrument: pending rows written by the production curation path; queue depth = total over every labelled save)`,
    head.map((h) => h.padStart(15)).join(''),
  ];
  for (const p of points) {
    const per = (s: CandidateSource) => (p.unrelatedRowsBySource[s] / p.unrelatedSaves).toFixed(2);
    lines.push(
      [
        p.floor.toFixed(2),
        rate(p.surfaced['near-duplicate']),
        rate(p.surfaced['expanded-rewrite']),
        rate(p.surfaced.contradiction),
        per('fts'),
        per('vec'),
        per('entity'),
        String(p.totalRows),
        admissible(arm, p) ? 'yes' : 'no',
      ]
        .map((c) => c.padStart(15))
        .join(''),
    );
  }
  return lines;
}
