import { type Embedder, loadEmbedder } from '../../embeddings/embedder.js';

import { CORPUS } from './corpus.js';
import { ingestCorpus } from './ingest.js';
import { SAVE_TIME_BASE, SAVE_TIME_SAVES } from './save-time-fixture.js';
import {
  admissible,
  formatArm,
  MIN_PLATEAU_WIDTH,
  type PointSummary,
  runSaveTimeArm,
  SAVE_TIME_FLOORS,
  SAVE_TIME_PER_SAVE_MAX,
  summarize,
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
    points.push(summarize(floor, await runSaveTimeArm(embedder, floor)));
  }
  return points;
}

async function retrievalCorpusPendingRows(embedder: Embedder, floor: number): Promise<number> {
  const corpus = await ingestCorpus(CORPUS, embedder, { lexicalFloor: floor });
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
  );
  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
