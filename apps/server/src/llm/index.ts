/**
 * LLM module barrel. Service code consumes only this entry point so the
 * underlying transport / SDK choice stays encapsulated.
 */

export { LlmClient } from './client.js';
export type {
  LlmClientOptions,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  EmbeddingsOptions,
  EmbeddingsResult,
} from './client.js';
export { LlmError } from './errors.js';
export type { LlmErrorCode } from './errors.js';
export { generate } from './generate.js';
export type { GenerateOptions } from './generate.js';
export { embed } from './embed.js';
