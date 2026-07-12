import type { NewAgentSession } from '../db/schema/agent-sessions.js';

export function agentSessionRow(
  overrides: Partial<NewAgentSession> & { id: string },
): NewAgentSession {
  return {
    tokenId: 'tk1',
    agent: 'claude-code',
    startedAt: new Date(1_000),
    ...overrides,
  };
}
