import { and, desc, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { prompts, type Prompt } from '../db/schema/prompts.js';

import { DomainError } from './errors.js';

/**
 * Append-only store of agent prompts.
 *
 * Records what the user asked. `memory.context.recentPrompts` queries
 * this table for the active scope so the next session sees prior asks.
 */

export interface SavePromptInput {
  content: string;
  sessionId?: string | null;
  projectId?: string | null;
  agent?: string | null;
}

export interface RecentForContextInput {
  projectId: string | null;
  limit?: number;
}

export class PromptsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(input: SavePromptInput): Prompt {
    if (input.content.trim().length === 0) {
      throw new DomainError('invalid_input', 'prompts.save: content must be non-empty');
    }
    const ts = this.now();
    const row = this.db
      .insert(prompts)
      .values({
        id: ulid(ts.getTime()),
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        content: input.content,
        agent: input.agent ?? null,
        createdAt: ts,
      })
      .returning()
      .get();
    if (!row) throw new DomainError('conflict', 'prompts.save: insert returned no row');
    return row;
  }

  recentForContext(input: RecentForContextInput): Prompt[] {
    const limit = clamp(input.limit ?? 10, 1, 50);
    const baseCondition =
      input.projectId === null ? isNull(prompts.projectId) : eq(prompts.projectId, input.projectId);
    return this.db
      .select()
      .from(prompts)
      .where(baseCondition)
      .orderBy(desc(prompts.createdAt))
      .limit(limit)
      .all();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Maintained imports for downstream consumers combining filters.
void and;
