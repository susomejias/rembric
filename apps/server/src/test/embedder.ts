import { createHash } from 'node:crypto';

import { EMBEDDING_DIMS, type Embedder } from '../embeddings/embedder.js';

/**
 * Deterministic in-memory embedder for tests. Vectors are derived from a
 * hash of the input and L2-normalized, so identical texts embed
 * identically and kNN queries are stable across runs — no model load, no
 * network. Mirrors the public `Embedder` surface.
 */
export class FakeEmbedder implements Embedder {
  public readonly modelId = 'fake-test-embedder';
  public readonly calls: string[] = [];
  private failNext: Error | null = null;

  /** Make the next embed() call reject (worker retry-path tests). */
  failOnce(err: Error = new Error('fake embedder failure')): void {
    this.failNext = err;
  }

  embed(text: string): Promise<Float32Array> {
    this.calls.push(text);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      return Promise.reject(err);
    }
    const vector = new Float32Array(EMBEDDING_DIMS);
    let seed = createHash('sha256').update(text).digest();
    let offset = 0;
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      if (offset >= seed.length) {
        seed = createHash('sha256').update(seed).digest();
        offset = 0;
      }
      vector[i] = (seed[offset]! - 128) / 128;
      offset++;
    }
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIMS; i++) norm += vector[i]! * vector[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBEDDING_DIMS; i++) vector[i] = vector[i]! / norm;
    return Promise.resolve(vector);
  }
}
