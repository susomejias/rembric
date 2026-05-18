import { createHash } from 'node:crypto';

import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  EmbeddingsOptions,
  EmbeddingsResult,
  LlmClient,
} from '../llm/index.js';

/**
 * Deterministic LLM mock for tests. Mirrors the public surface of
 * `LlmClient`. Two ways to drive responses:
 *
 *   1. `setChatResponse(...)` / `setEmbedding(...)` — exact handler.
 *   2. `setChatMatcher(predicate, handler)` — pattern-matched responses.
 *
 * If no rule matches a call the mock throws so tests fail loudly instead
 * of silently returning stale data.
 *
 * Embeddings default to a deterministic Float32Array derived from a hash
 * of the input so kNN queries are stable across runs without needing
 * real model output.
 */
export class MockLlmClient implements Pick<LlmClient, 'chatCompletion' | 'embeddings' | 'ping'> {
  public readonly chatCalls: ChatCompletionOptions[] = [];
  public readonly embeddingCalls: EmbeddingsOptions[] = [];
  public readonly pingCalls: number[] = [];

  private chatResponder?: (opts: ChatCompletionOptions) => ChatCompletionResult;
  private embeddingResponder?: (opts: EmbeddingsOptions) => EmbeddingsResult;
  private embeddingDim = 768;

  setChatResponse(content: string, finishReason: string = 'stop'): void {
    this.chatResponder = (opts) => ({
      content,
      finishReason,
      model: opts.model,
    });
  }

  setChatResponder(fn: (opts: ChatCompletionOptions) => ChatCompletionResult): void {
    this.chatResponder = fn;
  }

  /** Reply with a JSON-serialized object on the next chat call. */
  setChatJsonResponse(obj: unknown): void {
    this.chatResponder = (opts) => ({
      content: JSON.stringify(obj),
      finishReason: 'stop',
      model: opts.model,
    });
  }

  setEmbeddingDim(dim: number): void {
    this.embeddingDim = dim;
  }

  setEmbeddingResponder(fn: (opts: EmbeddingsOptions) => EmbeddingsResult): void {
    this.embeddingResponder = fn;
  }

  chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    this.chatCalls.push(opts);
    if (!this.chatResponder) {
      return Promise.reject(
        new Error(
          `MockLlmClient.chatCompletion called with no responder set (model=${opts.model})`,
        ),
      );
    }
    return Promise.resolve(this.chatResponder(opts));
  }

  embeddings(opts: EmbeddingsOptions): Promise<EmbeddingsResult> {
    this.embeddingCalls.push(opts);
    if (this.embeddingResponder) {
      return Promise.resolve(this.embeddingResponder(opts));
    }
    return Promise.resolve({
      embedding: deterministicEmbedding(opts.input, this.embeddingDim),
      model: opts.model,
    });
  }

  ping(_model?: string): Promise<{ ok: true; latencyMs: number }> {
    this.pingCalls.push(Date.now());
    return Promise.resolve({ ok: true, latencyMs: 1 });
  }

  reset(): void {
    this.chatCalls.length = 0;
    this.embeddingCalls.length = 0;
    this.pingCalls.length = 0;
    this.chatResponder = undefined;
    this.embeddingResponder = undefined;
  }
}

/** Cast helper to satisfy interfaces that expect the concrete LlmClient. */
export function asLlmClient(mock: MockLlmClient): LlmClient {
  return mock as unknown as LlmClient;
}

function deterministicEmbedding(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const seed = createHash('sha256').update(text).digest();
  for (let i = 0; i < dim; i++) {
    // Spread the 32-byte hash across the vector and normalize roughly into
    // [-1, 1]. Stable across runs, good enough for tests that only check
    // relative similarity.
    const byte = seed[i % seed.length] ?? 0;
    out[i] = byte / 127.5 - 1;
  }
  return out;
}
