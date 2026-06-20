import { existsSync } from 'node:fs';

/**
 * In-process embedder. The model is part of the engine, not configuration:
 * gte-multilingual-base (Apache 2.0), ONNX q8, 768 dims, cls pooling,
 * normalized output — pinned constants, calibrated thresholds live in
 * `save-time-candidates.ts`.
 *
 * Loaded eagerly at boot and REQUIRED for boot to succeed (fail fast: a
 * broken or missing model turns the deploy red instead of degrading
 * silently). From the baked image the load takes ~1.1s; once the server
 * is listening the model is always warm — there is no cold state.
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

/**
 * Load the model and return the embedder. Called once by bootstrap,
 * before the HTTP listener starts; a load failure aborts the boot.
 */
export async function loadEmbedder(): Promise<Embedder> {
  const { env, pipeline } = await import('@huggingface/transformers');
  // The baked model dir only exists in the Docker image (produced and
  // offline-validated by scripts/fetch-model.mjs in local-model layout).
  // Present → resolve locally, refuse network. Absent (dev machines) →
  // download at the pinned revision into the default cache; the first
  // bare-metal boot blocks on that download, once.
  // REMBRIC_MODEL_CACHE overrides the dir (CI prefetches the same layout
  // and points here so the suite resolves offline, never the HF CDN).
  const localModelDir = process.env.REMBRIC_MODEL_CACHE ?? IMAGE_MODEL_CACHE;
  const baked = existsSync(localModelDir);
  if (baked) {
    env.localModelPath = localModelDir;
    env.allowRemoteModels = false;
  }
  const pipe = (await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: EMBEDDING_DTYPE,
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
