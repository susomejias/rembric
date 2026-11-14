import {
  ProtocolErrorCode,
  type CallToolResult,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';

export interface DispatchedTool {
  registered: RegisteredTool;
  output: z.ZodType | undefined;
  call: (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
}

export function advertisedAsDraft07<T extends z.ZodType>(schema: T): T {
  const standard = schema['~standard'];
  const { input, output } = standard.jsonSchema;
  Object.defineProperty(schema, '~standard', {
    value: {
      ...standard,
      jsonSchema: {
        input: (options: Parameters<typeof input>[0]) => input({ ...options, target: 'draft-07' }),
        output: (options: Parameters<typeof output>[0]) =>
          output({ ...options, target: 'draft-07' }),
      },
    },
  });
  return schema;
}

export function invalidParams(message: string): Error {
  return new Error(`MCP error ${ProtocolErrorCode.InvalidParams}: ${message}`);
}

export function serveToolCalls(
  server: McpServer,
  tools: ReadonlyMap<string, DispatchedTool>,
): void {
  server.server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name } = request.params;
    try {
      const tool = tools.get(name);
      if (tool === undefined) throw invalidParams(`Tool ${name} not found`);
      if (!tool.registered.enabled) throw invalidParams(`Tool ${name} disabled`);
      const result = await tool.call(request.params.arguments, ctx);
      if (tool.output !== undefined && result.isError !== true) {
        if (!result.structuredContent) {
          throw invalidParams(
            `Output validation error: Tool ${name} has an output schema but no structured content was provided`,
          );
        }
        const checked = await tool.output.safeParseAsync(result.structuredContent);
        if (!checked.success) {
          throw invalidParams(
            `Output validation error: Invalid structured content for tool ${name}: ${checked.error.message}`,
          );
        }
      }
      return server.server.projectCallToolResult(result, tool.registered.outputSchemaJson);
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
}
