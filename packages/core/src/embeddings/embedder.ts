import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import identity from './model-identity.json' with { type: 'json' };

export const EMBEDDING_MODEL_ID = identity.modelId;
// JSON module types widen string literals; the transformers.js `dtype` option is a union.
export const EMBEDDING_DTYPE = identity.dtype as 'q8';
export const EMBEDDING_DIMS = identity.dims;
export const EMBEDDING_MODEL_REVISION = identity.revision;
export const EMBEDDING_ONNX_ARTIFACT = identity.onnxArtifact;

export function embeddingOnnxArtifactPath(modelsDir: string): string {
  return `${modelsDir}/${EMBEDDING_MODEL_ID}/${EMBEDDING_ONNX_ARTIFACT}`;
}

export const EMBEDDING_INPUT_VERSION = 'v2-title-content';

export function embeddingInput(title: string, content: string): string {
  return `${title}\n\n${content}`;
}

export function embeddingQueryInput(query: string): string {
  return query;
}

/** Model cache baked by the Dockerfile; present → fully offline. */
const IMAGE_MODEL_CACHE = '/app/models';

export interface Embedder {
  /** Compute a normalized 768-dim embedding. */
  embed(text: string): Promise<Float32Array>;
  readonly modelId: string;
}

export async function loadEmbedder(): Promise<Embedder> {
  const { env, pipeline } = await import('@huggingface/transformers');
  const localModelDir = process.env.REMBRIC_MODEL_CACHE ?? IMAGE_MODEL_CACHE;
  const baked = existsSync(localModelDir);
  if (baked) {
    env.localModelPath = localModelDir;
    env.allowRemoteModels = false;
  }
  const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: EMBEDDING_DTYPE,
    session_options: {
      intraOpNumThreads: Math.min(2, availableParallelism()),
      interOpNumThreads: 1,
    },
    ...(baked ? {} : { revision: EMBEDDING_MODEL_REVISION }),
  });

  return {
    modelId: EMBEDDING_MODEL_ID,
    async embed(text: string): Promise<Float32Array> {
      const out = await pipe(text, { pooling: 'cls', normalize: true });
      // Tensor.data is a union of typed arrays; pooling + normalize yields fp32.
      const data = out.data as Float32Array | number[];
      const vector = data instanceof Float32Array ? data : Float32Array.from(data);
      if (vector.length !== EMBEDDING_DIMS) {
        throw new Error(
          `embedder: expected ${EMBEDDING_DIMS} dims, got ${vector.length} — model artifacts do not match the pinned contract`,
        );
      }
      return vector;
    },
  };
}
