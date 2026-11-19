import { availableParallelism } from 'node:os';

import identity from './model-identity.json' with { type: 'json' };

export const RERANK_MODEL_ID = identity.modelId;
export const RERANK_MODEL_REVISION = identity.revision;
export const RERANK_ONNX_ARTIFACT = identity.onnxArtifact;
// JSON module types widen string literals; the transformers.js `dtype` option is a union.
const RERANK_DTYPE = identity.dtype as 'fp32';

export const RERANK_WINDOW = 10;
export const RERANK_MAX_TOKENS = 192;
export const RERANK_DEADLINE_MS = 300;
const RERANK_BATCH = 5;

export function rerankOnnxArtifactPath(modelsDir: string): string {
  return `${modelsDir}/${RERANK_MODEL_ID}/${RERANK_ONNX_ARTIFACT}`;
}

export type RerankScorer = (query: string, documents: readonly string[]) => Promise<number[]>;

/** Loads the cross-encoder in the CALLING thread; the server only calls it from the rerank worker. */
export async function loadRerankScorer(modelsDir: string | null): Promise<RerankScorer> {
  const { env, AutoModelForSequenceClassification, AutoTokenizer } =
    await import('@huggingface/transformers');
  if (modelsDir !== null) {
    env.localModelPath = modelsDir;
    env.allowRemoteModels = false;
  }
  const pinned = modelsDir === null ? { revision: RERANK_MODEL_REVISION } : {};
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID, pinned);
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
    ...pinned,
    dtype: RERANK_DTYPE,
    session_options: {
      intraOpNumThreads: Math.min(2, availableParallelism()),
      interOpNumThreads: 1,
    },
  });
  return async (query, documents) => {
    const scores: number[] = [];
    for (let start = 0; start < documents.length; start += RERANK_BATCH) {
      const batch = documents.slice(start, start + RERANK_BATCH);
      const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
        text_pair: [...batch],
        padding: true,
        truncation: true,
        max_length: RERANK_MAX_TOKENS,
      });
      const { logits } = (await model(inputs)) as { logits: { data: ArrayLike<number> } };
      for (let i = 0; i < batch.length; i++) scores.push(1 / (1 + Math.exp(-logits.data[i]!)));
    }
    if (scores.length !== documents.length) {
      throw new Error(`reranker: expected ${documents.length} scores, got ${scores.length}`);
    }
    return scores;
  };
}
