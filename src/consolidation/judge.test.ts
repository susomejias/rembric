import { describe, expect, it } from 'vitest';

import type { Memory } from '../db/schema/memory.js';
import { LlmError } from '../llm/index.js';
import { asLlmClient, MockLlmClient } from '../test/index.js';

import { judge, judgeDecisionSchema } from './judge.js';

function mem(id: string, content: string): Memory {
  return {
    id,
    scope: 'project',
    projectId: 'p',
    type: 'user',
    content,
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    source: null,
    sessionId: null,
    topicKey: null,
  };
}

describe('judgeDecisionSchema', () => {
  it('accepts a merge decision', () => {
    expect(
      judgeDecisionSchema.parse({
        decision: 'merge',
        affectedIds: ['a', 'b'],
        mergedContent: 'merged',
        reasoning: 'they say the same thing',
      }).decision,
    ).toBe('merge');
  });

  it('accepts null winnerId for non-supersede decisions', () => {
    expect(
      judgeDecisionSchema.parse({
        decision: 'merge',
        affectedIds: ['a', 'b'],
        mergedContent: 'merged',
        winnerId: null,
        reasoning: 'ok',
      }).winnerId,
    ).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(() =>
      judgeDecisionSchema.parse({
        decision: 'merge',
        affectedIds: ['a'],
        // missing reasoning
      }),
    ).toThrow();
  });
});

describe('judge() against the LLM mock', () => {
  it('returns the structured decision when the LLM produces valid JSON', async () => {
    const llm = new MockLlmClient();
    llm.setChatJsonResponse({
      decision: 'merge',
      affectedIds: ['a', 'b'],
      mergedContent: 'unified',
      reasoning: 'twins',
    });

    const decision = await judge({
      client: asLlmClient(llm),
      model: 'test',
      candidates: [mem('a', 'one'), mem('b', 'two')],
    });

    expect(decision.decision).toBe('merge');
    expect(decision.mergedContent).toBe('unified');
    expect(llm.chatCalls.length).toBe(1);
  });

  it('throws schema_violation when the LLM returns malformed JSON', async () => {
    const llm = new MockLlmClient();
    llm.setChatResponse('not json at all');
    await expect(
      judge({
        client: asLlmClient(llm),
        model: 'test',
        candidates: [mem('a', 'x'), mem('b', 'y')],
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('throws schema_violation when JSON is missing required fields', async () => {
    const llm = new MockLlmClient();
    llm.setChatJsonResponse({ decision: 'merge' });
    await expect(
      judge({
        client: asLlmClient(llm),
        model: 'test',
        candidates: [mem('a', 'x'), mem('b', 'y')],
      }),
    ).rejects.toMatchObject({ code: 'schema_violation' });
  });
});
