import { LlmError } from './errors.js';

/**
 * Minimal OpenAI-compatible client.
 *
 * Targets the OpenAI Chat Completions / Embeddings API shape exposed by:
 *   - OpenAI itself (https://api.openai.com/v1)
 *   - Ollama         (http://host:11434/v1, since 0.1.16)
 *   - LM Studio, vLLM, Groq, Together, Anyscale, etc.
 *
 * The caller passes a `baseUrl` that already includes the `/v1` segment.
 * Paths appended below are `/chat/completions`, `/embeddings`, `/models`.
 * No SDK dependency — `fetch` + a few timeouts is enough.
 */

export interface LlmClientOptions {
  baseUrl: string;
  apiKey?: string | null;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries on transient errors. */
  maxRetries?: number;
  /** Backoff base in ms (exponential: base * 2^attempt). */
  backoffMs?: number;
  /** Override `fetch` for testing. */
  fetch?: typeof globalThis.fetch;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Request a JSON object response (OpenAI-compatible "json_object"). */
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
  model: string;
}

export interface EmbeddingsOptions {
  model: string;
  input: string;
  signal?: AbortSignal;
}

export interface EmbeddingsResult {
  embedding: Float32Array;
  model: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: LlmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
    };
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
    if (opts.responseFormat === 'json_object') {
      body['response_format'] = { type: 'json_object' };
    }

    const response = await this.request<ChatCompletionResponse>(
      '/chat/completions',
      body,
      opts.signal,
    );

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new LlmError('invalid_response', 'chat completion response missing content');
    }

    return {
      content: choice.message.content,
      finishReason: choice.finish_reason ?? null,
      model: response.model ?? opts.model,
    };
  }

  async embeddings(opts: EmbeddingsOptions): Promise<EmbeddingsResult> {
    const body = {
      model: opts.model,
      input: opts.input,
    };

    const response = await this.request<EmbeddingsResponse>('/embeddings', body, opts.signal);

    const first = response.data[0];
    if (!first || !Array.isArray(first.embedding)) {
      throw new LlmError('invalid_response', 'embeddings response missing vector');
    }

    return {
      embedding: Float32Array.from(first.embedding),
      model: response.model ?? opts.model,
    };
  }

  /** Lightweight health-check: list models if supported, else short chat. */
  async ping(model?: string): Promise<{ ok: true; latencyMs: number }> {
    const start = Date.now();
    try {
      // Most OpenAI-compatible providers expose /v1/models.
      const url = `${this.baseUrl}/models`;
      const res = await this.fetchImpl(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        return { ok: true, latencyMs: Date.now() - start };
      }
    } catch {
      // fall through to chat-based ping
    }

    if (!model) {
      throw new LlmError(
        'http_error',
        'ping failed: /models unavailable and no model provided for chat-based fallback',
      );
    }

    await this.chatCompletion({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, latencyMs: Date.now() - start };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const composedSignal = signal ? anySignal([signal, controller.signal]) : controller.signal;

      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify(body),
          signal: composedSignal,
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < this.maxRetries) {
            await sleep(this.backoffMs * 2 ** attempt);
            attempt++;
            continue;
          }
          throw new LlmError(
            res.status === 429 ? 'rate_limited' : 'http_error',
            `${path} returned HTTP ${res.status}`,
          );
        }

        if (res.status === 401 || res.status === 403) {
          throw new LlmError(
            'auth',
            `${path} returned HTTP ${res.status} (check OPENAI_API_KEY or your provider's API key)`,
          );
        }

        if (!res.ok) {
          throw new LlmError('http_error', `${path} returned HTTP ${res.status}`);
        }

        const json = (await res.json()) as T;
        return json;
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          if (signal?.aborted) throw err;
          throw new LlmError('timeout', `${path} timed out after ${this.timeoutMs}ms`, err);
        }
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new LlmError('network', `${path} network failure`, err);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

interface ChatCompletionResponse {
  model?: string;
  choices: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

interface EmbeddingsResponse {
  model?: string;
  data: Array<{ embedding: number[] }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
