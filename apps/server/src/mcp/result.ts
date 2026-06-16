import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// `structuredContent` is the JSON round-trip of the payload so it equals the
// wire JSON (Dates → ISO strings) the outputSchema validates before transport.
// Every caller passes an object, so the parsed JSON is always a record.
export function ok(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}
