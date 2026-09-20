import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// `structuredContent` is the JSON round-trip of the payload so it equals the
// wire JSON (Dates → ISO strings) the outputSchema validates before transport.
// Every caller passes an object, so the parsed JSON is always a record.
export function ok(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  let structuredContent: Record<string, unknown>;
  try {
    // JSON.stringify's output is always valid JSON on the same value, so this
    // parse cannot throw — the round-trip IS the normalisation (Dates → ISO
    // strings). If it ever fires, the invariant was broken by a refactoring.
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
