import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import { type Prompt } from '../db/schema/prompts.js';

import { DomainError } from './errors.js';
import { sanitizeFtsQuery } from './hybrid-search.js';
import { type Scope } from './scope.js';

const PROMPT_TITLE_MAX_LENGTH = 100;
const PROMPT_PURGE_REASONING = 'operator purge of soft-deleted prompts';

/**
 * Append-only store of curated user prompts.
 *
 * Records what the user explicitly stated as a goal/constraint/directive
 * worth remembering, written via `memory.save_prompt`. Surfaced to future
 * sessions via `memory.context.recentPrompts` and retrievable via
 * `memory.search_prompts` (FTS5 over content + tags).
 *
 * Append-only contract (mirrors memory + sessions):
 *   - `content` is IMMUTABLE — no UPDATE-capable code path.
 *   - Lifecycle = `deleted_at` flips (operator soft-delete OR atomic refine
 *     via `replaces`) plus the `replaces` link itself.
 *   - This file is the ONLY emitter allowed of `DELETE FROM prompts`
 *     (via `purgeDeleted`); enforced by `apps/server/src/test/invariants.test.ts`.
 */

export interface SavePromptInput {
  content: string;
  /** Required scannable label for retrieval lists. 1..100 chars (app-layer). */
  title: string;
  sessionId?: string | null;
  projectId?: string | null;
  agent?: string | null;
  /** JSON-encoded array of categorical labels; each must be non-empty. */
  tags?: string[] | null;
  /**
   * Atomic refine: id of a predecessor prompt to supersede. The
   * predecessor MUST belong to the same scope (same `project_id`) and
   * must not already be soft-deleted; otherwise the call is rejected.
   */
  replaces?: string | null;
}

export interface RecentForContextInput {
  projectId: string | null;
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
  clamped: boolean;
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

  /**
   * Soft-delete a prompt by setting `deleted_at` to the current time.
   * Idempotent: a second call on an already-deleted row is a no-op.
   * Operator-facing — the dashboard's per-row Delete button calls this.
   */
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

  /**
   * Clear `deleted_at`, returning the prompt to visibility. Idempotent.
   */
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

  /**
   * Physically delete soft-deleted prompts. ONLY emitter of `DELETE FROM prompts`.
   * Journals into `consolidation_ops` with `op_type='prompt_purge'`.
   */
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

  /**
   * N most recent active prompts for the given scope, ordered newest first.
   * Soft-deleted rows are NEVER surfaced via this path — recentPrompts must
   * not contain takes the operator (or the agent via refine) marked as
   * obsolete.
   */
  recentForContext(input: RecentForContextInput): Prompt[] {
    const limit = clamp(input.limit ?? 10, 1, 50);
    return this.repos.prompts.recentForContext(input.projectId, limit);
  }

  /**
   * Scope-aware prompt search.
   *
   * When `input.query` is non-empty, JOINs against `prompts_fts MATCH ?`
   * for token-aware retrieval over content + tags. Otherwise falls back to
   * recency. Structured filters (`sessionId`, `agent`, `includeDeleted`)
   * apply on top of either path.
   *
   * Always fetches full rows via drizzle's query builder so JSON columns
   * (`tags`, `replaces`) are properly deserialized; the FTS5 path uses raw
   * SQL only to surface matching rowids in MATCH-rank order.
   */
  searchByScope(input: SearchByScopeInput): SearchByScopeResult {
    const requestedLimit = input.limit ?? 25;
    const limit = clamp(requestedLimit, 1, 100);
    const clamped = requestedLimit !== limit;
    const offset = Math.max(0, input.offset ?? 0);
    const projectId = input.scope.kind === 'project' ? input.scope.projectId : null;
    // Sanitize before it reaches `prompts_fts MATCH` — an arbitrary
    // natural-language query (punctuation, an unbalanced quote, a bareword
    // FTS5 operator) would otherwise raise a syntax error. Empty after
    // sanitizing means "skip the FTS branch"; undefined falls back to the
    // recency path the same as no query at all.
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
    return { prompts, total, clamped };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
