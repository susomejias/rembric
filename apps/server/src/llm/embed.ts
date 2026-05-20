import type { LlmClient } from './client.js';

/**
 * Compute an embedding for a single text. Returns the vector as a typed
 * Float32Array, ready to be persisted into the sqlite-vec virtual table.
 */
export async function embed(
  client: LlmClient,
  model: string,
  text: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const result = await client.embeddings({ model, input: text, signal });
  return result.embedding;
}
