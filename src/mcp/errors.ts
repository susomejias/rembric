/**
 * Build an MCP-shaped error response with a stable `code` field embedded
 * in the JSON payload so clients (and tests) can branch on it without
 * parsing message strings.
 */
export function mcpError(code: string, message: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, code, message }, null, 2),
      },
    ],
  };
}
