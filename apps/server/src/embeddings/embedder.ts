import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * In-process embedder. The model is part of the engine, not configuration:
 * gte-multilingual-base (Apache 2.0), ONNX q8, 768 dims, cls pooling,
 * normalized output — pinned constants, calibrated thresholds live in
 * `save-time-candidates.ts`.
 *
 * Lazy: nothing loads until the first `embed()` call, so boot stays
 * instant and processes that never write never pay the model's RSS.
 * While loading, callers degrade exactly like a missing vector does —
 * candidate detection falls back to FTS5.
 *
 * transformers.js quirk (pinned): the model's custom `NewModel`
 * architecture resolves through the EncoderOnly fallback with a console
 * warning. Output correctness through that path is guarded by
 * `embedder.test.ts`; the dependency version is exact-pinned in
 * package.json — do not loosen it.
 */

export const EMBEDDING_MODEL_ID = 'onnx-community/gte-multilingual-base';
export const EMBEDDING_DTYPE = 'q8';
export const EMBEDDING_DIMS = 768;

/** Image-local model root baked by the Dockerfile (HF layout: <root>/<model-id>). */
const IMAGE_MODEL_ROOT = '/app/models';

export interface Embedder {
  /** Compute a normalized 768-dim embedding. Triggers model load on first call. */
  embed(text: string): Promise<Float32Array>;
  /** True once the model finished loading (embed() resolves promptly). */
  isReady(): boolean;
  readonly modelId: string;
}

type FeaturePipeline = (
  text: string,
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export function createEmbedder(): Embedder {
  let pipelinePromise: Promise<FeaturePipeline> | null = null;
  let ready = false;

  const load = (): Promise<FeaturePipeline> => {
    pipelinePromise ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      if (existsSync(join(IMAGE_MODEL_ROOT, EMBEDDING_MODEL_ID))) {
        // Baked image: serve from local files, refuse network.
        env.localModelPath = IMAGE_MODEL_ROOT;
        env.allowRemoteModels = false;
      }
      const pipe = (await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        dtype: EMBEDDING_DTYPE,
      })) as unknown as FeaturePipeline;
      ready = true;
      return pipe;
    })();
    return pipelinePromise;
  };

  return {
    modelId: EMBEDDING_MODEL_ID,
    isReady: () => ready,
    async embed(text: string): Promise<Float32Array> {
      const pipe = await load();
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
