import { type Embedder, loadEmbedder } from '../../embeddings/embedder.js';
import { LEXICAL_CANDIDATE_FLOOR } from '../../services/save-time-candidates.js';

import { CORPUS } from './corpus.js';
import { ingestCorpus } from './ingest.js';
import { SAVE_TIME_BASE, SAVE_TIME_RELATED_SAVES, SAVE_TIME_SAVES } from './save-time-fixture.js';
import {
  admissible,
  formatArm,
  formatBands,
  MIN_PLATEAU_WIDTH,
  type PointSummary,
  runSaveTimeArm,
  SAVE_TIME_FLOORS,
  SAVE_TIME_PER_SAVE_MAX,
  summarize,
  summarizeBands,
  widestPlateau,
} from './save-time-sweep.js';

function memoized(embedder: Embedder): Embedder {
  const cache = new Map<string, Promise<Float32Array>>();
  return {
    modelId: embedder.modelId,
    embed(text) {
      const hit = cache.get(text);
      if (hit) return hit;
      const next = embedder.embed(text);
      cache.set(text, next);
      return next;
    },
  };
}

async function sweepArm(embedder: Embedder | null): Promise<PointSummary[]> {
  const points: PointSummary[] = [];
  for (const floor of SAVE_TIME_FLOORS) {
    points.push(summarize(floor, await runSaveTimeArm(embedder, floor, undefined, false)));
  }
  return points;
}

async function retrievalCorpusPendingRows(
  embedder: Embedder,
  floor: number,
  bands = false,
): Promise<number> {
  const corpus = await ingestCorpus(CORPUS, embedder, { lexicalFloor: floor, bands });
  try {
    let rows = 0;
    for (const projectId of corpus.projectIdBySlug.values()) {
      rows += corpus.repos.relations.countPendingInScope({ projectId });
    }
    return rows;
  } finally {
    corpus.cleanup();
  }
}

async function main(): Promise<void> {
  const embedder = memoized(await loadEmbedder());
  const lexical = await sweepArm(null);
  const production = await sweepArm(embedder);

  const out: string[] = [
    '# rembric save-time calibration sweep',
    `fixture: ${SAVE_TIME_BASE.length} base memories, ${SAVE_TIME_SAVES.length} labelled saves; per-save cap ${SAVE_TIME_PER_SAVE_MAX}; embedding model ${embedder.modelId}`,
    '',
    ...formatArm('lexical-only', lexical),
    '',
    ...formatArm('production', production),
    '',
  ];

  const ok = SAVE_TIME_FLOORS.map(
    (_, i) => admissible('lexical-only', lexical[i]!) && admissible('production', production[i]!),
  );
  const plateau = widestPlateau(SAVE_TIME_FLOORS, ok);
  if (!plateau || plateau.width < MIN_PLATEAU_WIDTH) {
    out.push(
      `NO ADMISSIBLE PLATEAU at least ${MIN_PLATEAU_WIDTH.toFixed(2)} wide` +
        (plateau ? ` (widest: ${plateau.from.toFixed(2)}–${plateau.to.toFixed(2)})` : ''),
    );
    console.log(out.join('\n'));
    process.exitCode = 1;
    return;
  }
  out.push(
    `admissible plateau (both arms): ${plateau.from.toFixed(2)}–${plateau.to.toFixed(2)} (width ${plateau.width.toFixed(2)})`,
    `chosen floor (plateau midpoint on the grid): ${plateau.chosen.toFixed(2)}`,
    '',
    '## secondary series (not gating) — pending rows written while ingesting the retrieval corpus, production arm',
    `floor 0.00: ${await retrievalCorpusPendingRows(embedder, 0)}`,
    `floor ${plateau.chosen.toFixed(2)}: ${await retrievalCorpusPendingRows(embedder, plateau.chosen)}`,
    '',
    ...(await bandSection(embedder)),
  );
  console.log(out.join('\n'));
}

async function bandSection(embedder: Embedder): Promise<string[]> {
  const floor = LEXICAL_CANDIDATE_FLOOR;
  const fixture = { base: SAVE_TIME_BASE, saves: [...SAVE_TIME_SAVES, ...SAVE_TIME_RELATED_SAVES] };
  const off = await runSaveTimeArm(embedder, floor, fixture, false);
  const on = await runSaveTimeArm(embedder, floor, fixture, true);
  const depth = (o: typeof on) => o.reduce((n, s) => n + s.sources.length, 0);
  const n = fixture.saves.length;
  return [
    `## confidence bands — production arm, floor ${floor.toFixed(2)}, per-save cap ${SAVE_TIME_PER_SAVE_MAX}, ${n} saves (the ${SAVE_TIME_SAVES.length} labelled saves above, then ${SAVE_TIME_RELATED_SAVES.length} related)`,
    'instrument: pending rows written and related rows returned by the production curation path; "off" = bands seam disabled, every admitted pair pending',
    ...formatBands(summarizeBands(off, on)),
    `queue depth over ${n} saves: bands off ${depth(off)}, bands on ${depth(on)} (${(depth(off) / n).toFixed(2)} -> ${(depth(on) / n).toFixed(2)} per save)`,
    `retrieval corpus ingest, pending rows at floor ${floor.toFixed(2)}: bands off ${await retrievalCorpusPendingRows(embedder, floor)}, bands on ${await retrievalCorpusPendingRows(embedder, floor, true)}`,
  ];
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
