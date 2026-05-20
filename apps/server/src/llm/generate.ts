import type { z } from 'zod';

import type { ChatMessage, LlmClient } from './client.js';
import { LlmError } from './errors.js';

/**
 * Generate a structured response from the LLM and validate it against a zod
 * schema. Uses the OpenAI-compatible `response_format: json_object` hint so
 * compliant models return parseable JSON.
 *
 * On schema violation we throw `LlmError('schema_violation', ...)`, leaving
 * the caller to record the failure in the consolidation journal and move on.
 */

export interface GenerateOptions<TSchema extends z.ZodTypeAny> {
  client: LlmClient;
  model: string;
  schema: TSchema;
  /** System prompt enforcing JSON output. */
  system: string;
  /** User content describing the task. */
  user: string;
  temperature?: number;
  signal?: AbortSignal;
}

export async function generate<TSchema extends z.ZodTypeAny>(
  opts: GenerateOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  const result = await opts.client.chatCompletion({
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0,
    responseFormat: 'json_object',
    signal: opts.signal,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch (err) {
    throw new LlmError(
      'schema_violation',
      `LLM returned non-JSON content: ${result.content.slice(0, 200)}`,
      err,
    );
  }

  const validated = opts.schema.safeParse(parsed);
  if (!validated.success) {
    throw new LlmError(
      'schema_violation',
      `LLM JSON failed schema validation: ${validated.error.message}`,
      validated.error,
    );
  }

  return validated.data as z.infer<TSchema>;
}
