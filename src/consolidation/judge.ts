import { z } from 'zod';

import type { Memory } from '../db/schema/memory.js';
import { generate, type LlmClient } from '../llm/index.js';

/**
 * The LLM judge: given a set of candidate memories that may relate to each
 * other (near-duplicates, contradictions, drift), it proposes a structured
 * decision describing what to merge / supersede / leave alone.
 *
 * The decision is validated against a zod schema before any DB mutation
 * happens; malformed responses become 'noop' ops in the consolidation journal.
 */

export const judgeDecisionSchema = z.object({
  decision: z.enum(['merge', 'supersede', 'keep_separate']),
  /** Memory ids participating in the operation (a subset of the input). */
  affectedIds: z.array(z.string()).min(1).max(16),
  /**
   * For `merge`: the new consolidated content. For `supersede`: the id of
   * the winning memory (must be in affectedIds). For `keep_separate`: omitted.
   */
  // Models occasionally return explicit nulls instead of omitting these
  // fields when they're inapplicable to the chosen decision. Accept both.
  mergedContent: z.string().nullable().optional(),
  winnerId: z.string().nullable().optional(),
  /** Free-form rationale, recorded in `consolidation_ops.reasoning`. */
  reasoning: z.string().min(1).max(2_000),
});

export type JudgeDecision = z.infer<typeof judgeDecisionSchema>;

const SYSTEM_PROMPT = `You are the consolidation judge for an agent memory system.

Given a small set of related memories, decide whether they should be:
  - merged into a single new memory (when they say the same thing in different
    words or accumulate complementary facts about the same subject),
  - superseded (when one is strictly newer/better and the others should be
    marked obsolete),
  - or kept separate (when the relationship is incidental).

Rules:
  - Be conservative. Prefer "keep_separate" if you are unsure.
  - For "merge": produce a single concise sentence or two that captures the
    union of facts, in the user's voice. Reference the original source
    timestamps if relevant.
  - For "supersede": pick the most recent and accurate memory as the winner.
  - Never invent facts that aren't in the inputs.
  - Output only the JSON object — nothing else.`;

export interface RunJudgeOptions {
  client: LlmClient;
  model: string;
  candidates: Memory[];
}

export async function judge(opts: RunJudgeOptions): Promise<JudgeDecision> {
  const user = formatCandidates(opts.candidates);
  return generate({
    client: opts.client,
    model: opts.model,
    schema: judgeDecisionSchema,
    system: SYSTEM_PROMPT,
    user,
    temperature: 0,
  });
}

function formatCandidates(memories: Memory[]): string {
  const lines: string[] = [
    'Candidates (decide whether to merge, supersede, or keep_separate):',
    '',
  ];
  for (const m of memories) {
    lines.push(`- id: ${m.id}`);
    lines.push(`  type: ${m.type}`);
    lines.push(`  created_at: ${m.createdAt.toISOString()}`);
    if (m.tags.length > 0) lines.push(`  tags: ${m.tags.join(', ')}`);
    lines.push(`  content: ${m.content}`);
    lines.push('');
  }
  lines.push(
    'Respond with a JSON object matching this shape:',
    '{ "decision": "merge"|"supersede"|"keep_separate",',
    '  "affectedIds": ["..."],',
    '  "mergedContent": "<for merge only>",',
    '  "winnerId": "<for supersede only>",',
    '  "reasoning": "..." }',
  );
  return lines.join('\n');
}
