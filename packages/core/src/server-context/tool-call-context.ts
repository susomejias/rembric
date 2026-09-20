import { AsyncLocalStorage } from 'node:async_hooks';

import type { RequestId } from '@modelcontextprotocol/sdk/types.js';

/** JSON-RPC id of the executing tool call, captured at the `registerTool` funnel. */
const storage = new AsyncLocalStorage<RequestId>();

export function runWithToolCallId<T>(requestId: RequestId, fn: () => T): T {
  return storage.run(requestId, fn);
}

export function tryGetToolCallId(): RequestId | undefined {
  return storage.getStore();
}
