import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { mcpError } from './errors.js';

export function batchResult(
  payload: Record<string, unknown>,
  successes: number,
  errors: readonly { code?: string }[],
) {
  if (successes === 0 && errors.length > 0) {
    const code = errors.every((e) => e.code === 'not_found') ? 'not_found' : 'batch_failed';
    return mcpError(code, 'No requested item could be processed.', payload);
  }
  return ok(payload);
}

export function ok(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  let structuredContent: Record<string, unknown>;
  try {
    structuredContent = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new TypeError(`structuredContent round-trip invariant violated: ${message}`, {
      cause: e,
    });
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}
