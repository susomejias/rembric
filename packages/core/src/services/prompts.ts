import { type Prompt, type Repositories, type Scope, type TransactionRunner } from '@rembric/db';
import { ulid } from 'ulid';

import { DomainError } from './errors.js';
import { sanitizeFtsQuery } from './hybrid-search.js';

const PROMPT_TITLE_MAX_LENGTH = 100;
const PROMPT_PURGE_REASONING = 'operator purge of soft-deleted prompts';

export interface SavePromptInput {
  content: string;
  /** Required scannable label for retrieval lists. 1..100 chars (app-layer). */
  title: string;
  sessionId?: string | null;
  projectId?: string | null;
  agent?: string | null;
  /** JSON-encoded array of categorical labels; each must be non-empty. */
  tags?: string[] | null;
  replaces?: string | null;
}

export interface RecentPromptsForContextInput {
  projectId: string;
  limit?: number;
}

export interface SearchByScopeInput {
  scope: Scope;
  query?: string;
  sessionId?: string;
  agent?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchByScopeResult {
  prompts: Prompt[];
  total: number;
}

export class PromptsService {
  constructor(
    private readonly repos: Pick<Repositories, 'prompts' | 'consolidation'>,
    private readonly tx: TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(input: SavePromptInput): Prompt {
    if (input.content.trim().length === 0) {
      throw new DomainError('invalid_input', 'prompts.save: content must be non-empty');
    }
    if (
      typeof input.title !== 'string' ||
      input.title.length === 0 ||
      input.title.length > PROMPT_TITLE_MAX_LENGTH
    ) {
      throw new DomainError(
        'invalid_input',
        `prompts.save: title is required and must be 1..${PROMPT_TITLE_MAX_LENGTH} chars`,
      );
    }
    if (input.tags) {
      for (const tag of input.tags) {
        if (typeof tag !== 'string' || tag.length === 0) {
          throw new DomainError('invalid_input', 'prompts.save: tags must be non-empty strings');
        }
      }
    }

    if (input.replaces) {
      return this.saveWithReplaces(input, input.replaces);
    }
    return this.insertRow(input);
  }

  private insertRow(input: SavePromptInput, replaces?: string[]): Prompt {
    const ts = this.now();
    const row = this.repos.prompts.insert({
      id: ulid(ts.getTime()),
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      content: input.content,
      title: input.title,
      tags: input.tags ?? null,
      replaces: replaces ?? null,
      agent: input.agent ?? null,
      createdAt: ts,
      deletedAt: null,
    });
    if (!row) throw new DomainError('conflict', 'prompts.save: insert returned no row');
    return row;
  }

  private saveWithReplaces(input: SavePromptInput, predecessorId: string): Prompt {
    return this.tx.transaction((): Prompt => {
      const predecessor = this.repos.prompts.findById(predecessorId);
      if (!predecessor) {
        throw new DomainError('prompt_not_found', `prompt '${predecessorId}' not found`);
      }
      if (predecessor.projectId !== (input.projectId ?? null)) {
        throw new DomainError(
          'prompt_scope_mismatch',
          `prompt '${predecessorId}' belongs to a different scope`,
        );
      }
      if (predecessor.deletedAt) {
        throw new DomainError(
          'prompt_already_deleted',
          `prompt '${predecessorId}' is already deleted; nothing to refine`,
        );
      }

      const ts = this.now();
      this.repos.prompts.setDeletedAt(predecessorId, ts);

      const inserted = this.repos.prompts.insert({
        id: ulid(ts.getTime()),
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        content: input.content,
        title: input.title,
        tags: input.tags ?? null,
        replaces: [predecessorId],
        agent: input.agent ?? null,
        createdAt: ts,
        deletedAt: null,
      });
      if (!inserted) {
        throw new DomainError('conflict', 'prompts.save: refine insert returned no row');
      }
      return inserted;
    });
  }

  softDelete(id: string, _opts: { adminBypass?: boolean } = {}): Prompt {
    void _opts;
    const existing = this.findById(id);
    if (!existing) {
      throw new DomainError('prompt_not_found', `prompt '${id}' not found`);
    }
    if (existing.deletedAt) {
      return existing;
    }
    const updated = this.repos.prompts.setDeletedAt(id, this.now());
    if (!updated) {
      throw new DomainError('prompt_not_found', `prompt '${id}' not found`);
    }
    return updated;
  }

  undelete(id: string, _opts: { adminBypass?: boolean } = {}): Prompt {
    void _opts;
    const existing = this.findById(id);
    if (!existing) {
      throw new DomainError('prompt_not_found', `prompt '${id}' not found`);
    }
    if (!existing.deletedAt) {
      return existing;
    }
    const updated = this.repos.prompts.setDeletedAt(id, null);
    if (!updated) {
      throw new DomainError('prompt_not_found', `prompt '${id}' not found`);
    }
    return updated;
  }

  purgeDeleted(input: { adminBypass: true }): { deletedIds: string[] } {
    if (input?.adminBypass !== true) {
      throw new DomainError(
        'forbidden',
        'prompts.purgeDeleted: adminBypass:true required (admin-only operation)',
      );
    }
    const ts = this.now();

    return this.tx.transaction((): { deletedIds: string[] } => {
      const deletedIds = this.repos.prompts.findDeletedIds();
      if (deletedIds.length === 0) {
        return { deletedIds: [] };
      }

      this.repos.prompts.purgeByIds(deletedIds);

      const runId = ulid(ts.getTime());
      this.repos.consolidation.insertRun({
        id: runId,
        startedAt: ts,
        finishedAt: ts,
        scope: 'maintenance',
        summary: JSON.stringify({ kind: 'prompt_purge', deleted: deletedIds.length }),
      });
      this.repos.consolidation.insertOp({
        id: ulid(ts.getTime()),
        runId,
        opType: 'prompt_purge',
        affectedIds: deletedIds,
        createdId: null,
        reasoning: PROMPT_PURGE_REASONING,
        appliedAt: ts,
      });

      return { deletedIds };
    });
  }

  /** Count prompts currently eligible for `purgeDeleted` (soft-deleted rows). */
  countPurgeableDeleted(): number {
    return this.repos.prompts.countDeleted();
  }

  findById(id: string): Prompt | undefined {
    return this.repos.prompts.findById(id);
  }

  recentForContext(input: RecentPromptsForContextInput): Prompt[] {
    const limit = clamp(input.limit ?? 10, 1, 50);
    return this.repos.prompts.recentForContext(input.projectId, limit);
  }

  searchByScope(input: SearchByScopeInput): SearchByScopeResult {
    const requestedLimit = input.limit ?? 25;
    const limit = clamp(requestedLimit, 1, 100);
    const offset = Math.max(0, input.offset ?? 0);
    const projectId = input.scope.projectId;
    const sanitized = input.query ? sanitizeFtsQuery(input.query) : undefined;

    const { prompts, total } = this.repos.prompts.searchByScope({
      projectId,
      query: sanitized || undefined,
      sessionId: input.sessionId,
      agent: input.agent,
      includeDeleted: input.includeDeleted,
      limit,
      offset,
    });
    return { prompts, total };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
