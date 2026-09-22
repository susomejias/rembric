import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export const EMBEDDING_MODEL_ID = 'onnx-community/gte-multilingual-base';
export const EMBEDDING_DTYPE = 'q8';
export const EMBEDDING_DIMS = 768;

export const EMBEDDING_INPUT_VERSION = 'v2-title-content';

export function embeddingInput(title: string, content: string): string {
  return `${title}\n\n${content}`;
}

export function embeddingQueryInput(query: string): string {
  return query;
}
/** Pinned HF revision — build-time fetch and dev downloads MUST agree. */
export const EMBEDDING_MODEL_REVISION = '2edbf5e672aab465f9ed4c154a8b61791c082c69';

/** Model cache baked by the Dockerfile; present → fully offline. */
const IMAGE_MODEL_CACHE = '/app/models';

export interface Embedder {
  /** Compute a normalized 768-dim embedding. */
  embed(text: string): Promise<Float32Array>;
  readonly modelId: string;
}

type FeaturePipeline = (
  text: string,
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export async function loadEmbedder(): Promise<Embedder> {
  const { env, pipeline } = await import('@huggingface/transformers');
  const localModelDir = process.env.REMBRIC_MODEL_CACHE ?? IMAGE_MODEL_CACHE;
  const baked = existsSync(localModelDir);
  if (baked) {
    env.localModelPath = localModelDir;
    env.allowRemoteModels = false;
  }
  const pipe = (await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: EMBEDDING_DTYPE,
    session_options: {
      intraOpNumThreads: Math.min(2, availableParallelism()),
      interOpNumThreads: 1,
    },
    ...(baked ? {} : { revision: EMBEDDING_MODEL_REVISION }),
  })) as unknown as FeaturePipeline;

  return {
    modelId: EMBEDDING_MODEL_ID,
    async embed(text: string): Promise<Float32Array> {
      const out = await pipe(text, { pooling: 'cls', normalize: true });
      const vector = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
      if (vector.length !== EMBEDDING_DIMS) {
        throw new Error(
          `embedder: expected ${EMBEDDING_DIMS} dims, got ${vector.length} — model artifacts do not match the pinned contract`,
        );
      }
      return vector;
    },
  };
}
