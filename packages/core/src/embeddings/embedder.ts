import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import { memoryText } from '../services/memory-text.js';

import identity from './model-identity.json' with { type: 'json' };

export const EMBEDDING_MODEL_ID = identity.modelId;
// JSON module types widen string literals; the transformers.js `dtype` and `pooling` options are unions.
export const EMBEDDING_DTYPE = identity.dtype as 'fp32';
export const EMBEDDING_POOLING = identity.pooling as 'mean';
export const EMBEDDING_DIMS = identity.dims;
export const EMBEDDING_MODEL_REVISION = identity.revision;
export const EMBEDDING_ONNX_ARTIFACT = identity.onnxArtifact;

export function embeddingOnnxArtifactPath(modelsDir: string): string {
  return `${modelsDir}/${EMBEDDING_MODEL_ID}/${EMBEDDING_ONNX_ARTIFACT}`;
}

export const EMBEDDING_MAX_TOKENS = identity.maxTokens;

export const EMBEDDING_INPUT_VERSION = `v3-title-content-max${EMBEDDING_MAX_TOKENS}`;

export function embeddingInput(title: string, content: string): string {
  return memoryText(title, content);
}

export function embeddingQueryInput(query: string): string {
  return query;
}

/** Model cache baked by the Dockerfile; present → fully offline. */
const IMAGE_MODEL_CACHE = '/app/models';

/** True when the model files exist locally, so loading it cannot hit the network. */
export function embedderModelIsBaked(): boolean {
  return bakedModelsDir() !== null;
}

/** The local model cache when present; `null` means models load from the network at a pinned revision. */
export function bakedModelsDir(): string | null {
  const dir = process.env['REMBRIC_MODEL_CACHE'] ?? IMAGE_MODEL_CACHE;
  return existsSync(dir) ? dir : null;
}

export interface Embedder {
  /** Compute a normalized `EMBEDDING_DIMS`-dim embedding. */
  embed(text: string): Promise<Float32Array>;
  readonly modelId: string;
}

export async function loadEmbedder(): Promise<Embedder> {
  const { env, AutoModel, AutoTokenizer, mean_pooling } = await import('@huggingface/transformers');
  if (EMBEDDING_POOLING !== 'mean') {
    throw new Error(`embedder: unsupported pooling ${String(EMBEDDING_POOLING)}`);
  }
  const localModelDir = process.env.REMBRIC_MODEL_CACHE ?? IMAGE_MODEL_CACHE;
  const baked = existsSync(localModelDir);
  if (baked) {
    env.localModelPath = localModelDir;
    env.allowRemoteModels = false;
  }
  const pinned = baked ? {} : { revision: EMBEDDING_MODEL_REVISION };
  const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID, pinned);
  const model = await AutoModel.from_pretrained(EMBEDDING_MODEL_ID, {
    ...pinned,
    dtype: EMBEDDING_DTYPE,
    session_options: {
      intraOpNumThreads: Math.min(2, availableParallelism()),
      interOpNumThreads: 1,
    },
  });

  return {
    modelId: EMBEDDING_MODEL_ID,
    async embed(text: string): Promise<Float32Array> {
      const inputs = tokenizer(text, { truncation: true, max_length: EMBEDDING_MAX_TOKENS });
      const { last_hidden_state } = (await model(inputs)) as {
        last_hidden_state: Parameters<typeof mean_pooling>[0];
      };
      const pooled = mean_pooling(last_hidden_state, inputs.attention_mask).normalize(2, -1);
      // Tensor.data is a union of typed arrays; mean pooling + normalize yields fp32.
      const data = pooled.data as Float32Array | number[];
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
