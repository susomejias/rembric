import { writeFileSync } from 'node:fs';

import { loadEmbedder } from '../../embeddings/embedder.js';

import { CORPUS } from './corpus.js';
import { ingestCorpus } from './ingest.js';
import { QUERIES } from './queries.js';
import { resolveScope } from './resolve.js';
import { hybridRetriever } from './retrievers/hybrid.js';

/**
 * Per-query result composition of the production ranked path, keyed
 * `<queryId>@<limit>` and projected to the corpus's STABLE fixture ids so two
 * runs are comparable across ingestions (the DB ids are ULIDs minted per run).
 *
 * Written to the path given as the first argument.
 */
const LIMITS = [5, 8, 200] as const;

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('usage: tsx src/test/retrieval/dump-ids.ts <out.json>');

  const embedder = await loadEmbedder();
  const corpus = await ingestCorpus(CORPUS, embedder);
  const stableIdById = new Map([...corpus.idByStableId].map(([stable, id]) => [id, stable]));

  const dump: Record<string, string[]> = {};
  let total = 0;
  try {
    for (const q of QUERIES) {
      const resolved = resolveScope(corpus, q);
      for (const limit of LIMITS) {
        // Through the retriever the harness scores, so the dump cannot drift
        // onto a different entry point than the one the eval measures.
        const { ids: rowIds } = await hybridRetriever.query(q.text, corpus, limit, resolved);
        const ids = rowIds.map((id) => stableIdById.get(id) ?? id);
        dump[`${q.id}@${limit}`] = ids;
        total += ids.length;
      }
    }
  } finally {
    corpus.cleanup();
  }

  if (total === 0) {
    throw new Error('the dump is empty — two empty sets hash identically, so it proves nothing');
  }
  writeFileSync(outPath, JSON.stringify(dump, null, 2) + '\n');
  console.log(`wrote ${outPath}: ${Object.keys(dump).length} entries, ${total} ids total`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
