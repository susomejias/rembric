import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
