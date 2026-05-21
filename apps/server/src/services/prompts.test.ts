import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consolidationOps } from '../db/schema/consolidation.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { ProjectsService } from './projects.js';
import { PromptsService } from './prompts.js';
import { SCOPE_GLOBAL, projectScope } from './scope.js';

/**
 * Typed helper for asserting on `DomainError.code` without tripping the
 * `@typescript-eslint/no-unsafe-argument` rule that fires on
 * `expect.objectContaining({ code: 'foo' })` (whose return is typed `any`).
 */
function withCode(code: string): Error {
  return expect.objectContaining({ code }) as Error;
}

let db: TestDb;
let prompts: PromptsService;
let projects: ProjectsService;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  prompts = new PromptsService(db.handle.db);
  projects = new ProjectsService(db.handle.db);
  projectId = projects.create({ slug: 'prompt-tests' }).id;
});

afterEach(() => db.cleanup());

describe('PromptsService.save', () => {
  it('persists a prompt with required content + title', () => {
    const row = prompts.save({ content: 'ship it', title: 'ship cue', projectId });
    expect(row.content).toBe('ship it');
    expect(row.title).toBe('ship cue');
    expect(row.projectId).toBe(projectId);
    expect(row.tags).toBeNull();
    expect(row.replaces).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it('persists optional tags alongside required title', () => {
    const row = prompts.save({
      content: 'ship it by friday',
      title: 'deadline',
      tags: ['deadline', 'auth'],
      projectId,
    });
    expect(row.title).toBe('deadline');
    expect(row.tags).toEqual(['deadline', 'auth']);
  });

  it('rejects title longer than 100 chars', () => {
    expect(() => prompts.save({ content: 'x', title: 'A'.repeat(101), projectId })).toThrowError(
      withCode('invalid_input'),
    );
  });

  it('rejects empty title', () => {
    expect(() => prompts.save({ content: 'x', title: '', projectId })).toThrowError(
      withCode('invalid_input'),
    );
  });

  it('rejects missing title (runtime guard mirrors the MCP schema)', () => {
    const fn = () =>
      // @ts-expect-error title is required by SavePromptInput; runtime guards belt-and-suspenders
      prompts.save({ content: 'x', projectId });
    expect(fn).toThrowError(withCode('invalid_input'));
  });

  it('rejects empty-string tag elements', () => {
    const fn = () => prompts.save({ content: 'x', title: 'titled', tags: ['ok', ''], projectId });
    expect(fn).toThrowError(withCode('invalid_input'));
  });

  it('rejects empty content', () => {
    expect(() => prompts.save({ content: '   ', title: 'titled', projectId })).toThrowError(
      withCode('invalid_input'),
    );
  });
});

describe('PromptsService.save with replaces (refine)', () => {
  it('atomically soft-deletes the predecessor and links the successor', () => {
    const p1 = prompts.save({ content: 'use OAuth', title: 'auth: OAuth', projectId });
    const p2 = prompts.save({
      content: 'use JWT rotated hourly',
      title: 'auth: JWT rotated',
      projectId,
      replaces: p1.id,
    });

    const after = prompts.findById(p1.id);
    expect(after?.deletedAt).not.toBeNull();
    expect(p2.replaces).toEqual([p1.id]);
    expect(p2.deletedAt).toBeNull();
  });

  it('rejects with code prompt_not_found when the predecessor does not exist', () => {
    const fn = () =>
      prompts.save({
        content: 'refined',
        title: 'refined',
        projectId,
        replaces: 'never-existed-id',
      });
    expect(fn).toThrow(/not found/i);
    expect(fn).toThrowError(withCode('prompt_not_found'));
  });

  it('rejects with code prompt_scope_mismatch when the predecessor is in another project', () => {
    const otherProjectId = projects.create({ slug: 'other-project' }).id;
    const p1 = prompts.save({
      content: 'foreign',
      title: 'foreign',
      projectId: otherProjectId,
    });
    const fn = () =>
      prompts.save({ content: 'refined', title: 'refined', projectId, replaces: p1.id });
    expect(fn).toThrowError(withCode('prompt_scope_mismatch'));
  });

  it('rejects with code prompt_already_deleted when the predecessor was already soft-deleted', () => {
    const p1 = prompts.save({ content: 'first take', title: 'take 1', projectId });
    prompts.softDelete(p1.id);
    const fn = () =>
      prompts.save({ content: 'second take', title: 'take 2', projectId, replaces: p1.id });
    expect(fn).toThrowError(withCode('prompt_already_deleted'));
  });
});

describe('PromptsService.softDelete / undelete', () => {
  it('softDelete flips deletedAt; second call is idempotent', () => {
    const p = prompts.save({ content: 'x', title: 'x', projectId });
    const deleted = prompts.softDelete(p.id);
    expect(deleted.deletedAt).not.toBeNull();
    const deletedAgain = prompts.softDelete(p.id);
    expect(deletedAgain.deletedAt?.getTime()).toBe(deleted.deletedAt?.getTime());
  });

  it('undelete clears deletedAt; second call on visible row is idempotent', () => {
    const p = prompts.save({ content: 'x', title: 'x', projectId });
    prompts.softDelete(p.id);
    const visible = prompts.undelete(p.id);
    expect(visible.deletedAt).toBeNull();
    const noOp = prompts.undelete(p.id);
    expect(noOp.deletedAt).toBeNull();
  });

  it('softDelete on a missing id throws prompt_not_found', () => {
    const fn = () => prompts.softDelete('never-existed');
    expect(fn).toThrowError(withCode('prompt_not_found'));
  });
});

describe('PromptsService.purgeDeleted', () => {
  it('physically removes only soft-deleted rows and journals a consolidation_op', () => {
    const p1 = prompts.save({ content: 'keep', title: 'keep', projectId });
    const p2 = prompts.save({ content: 'drop', title: 'drop', projectId });
    prompts.softDelete(p2.id);

    const { deletedIds } = prompts.purgeDeleted({ adminBypass: true });
    expect(deletedIds).toEqual([p2.id]);

    expect(prompts.findById(p1.id)).toBeDefined();
    expect(prompts.findById(p2.id)).toBeUndefined();

    const ops = db.handle.db.select().from(consolidationOps).all();
    const purgeOp = ops.find((o) => o.opType === 'prompt_purge');
    expect(purgeOp).toBeDefined();
    expect(purgeOp?.affectedIds).toEqual([p2.id]);
  });

  it('returns empty deletedIds when no soft-deleted rows exist', () => {
    prompts.save({ content: 'live', title: 'live', projectId });
    const { deletedIds } = prompts.purgeDeleted({ adminBypass: true });
    expect(deletedIds).toEqual([]);
  });

  it('requires adminBypass:true', () => {
    const fn = () =>
      // @ts-expect-error testing the runtime guard
      prompts.purgeDeleted({});
    expect(fn).toThrowError(withCode('forbidden'));
  });
});

describe('PromptsService.recentForContext', () => {
  it('returns only non-deleted prompts ordered newest first', () => {
    const p1 = prompts.save({ content: 'first', title: 'first', projectId });
    const p2 = prompts.save({ content: 'second', title: 'second', projectId });
    prompts.softDelete(p1.id);

    const recent = prompts.recentForContext({ projectId, limit: 10 });
    expect(recent.map((r) => r.id)).toEqual([p2.id]);
  });
});

describe('PromptsService.searchByScope', () => {
  it('performs FTS5 match over content', () => {
    prompts.save({ content: 'deploy via docker compose', title: 'deploy plan', projectId });
    prompts.save({ content: 'refactor the auth middleware', title: 'auth refactor', projectId });

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      query: 'deploy',
    });
    expect(result.prompts.map((p) => p.content)).toEqual(['deploy via docker compose']);
    expect(result.total).toBe(1);
    expect(result.clamped).toBe(false);
  });

  it('FTS5 match over tags', () => {
    prompts.save({
      content: 'unrelated text',
      title: 'tag deploy',
      tags: ['deploy', 'urgent'],
      projectId,
    });
    prompts.save({ content: 'also unrelated', title: 'tag style', tags: ['style'], projectId });

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      query: 'deploy',
    });
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.tags).toEqual(['deploy', 'urgent']);
  });

  it('falls back to recency when no query is given', () => {
    const p1 = prompts.save({ content: 'first', title: 'first', projectId });
    const p2 = prompts.save({ content: 'second', title: 'second', projectId });

    const result = prompts.searchByScope({ scope: projectScope(projectId) });
    expect(result.prompts.map((p) => p.id)).toEqual([p2.id, p1.id]);
  });

  it('excludes soft-deleted prompts by default', () => {
    const p1 = prompts.save({ content: 'keep', title: 'keep', projectId });
    const p2 = prompts.save({ content: 'drop', title: 'drop', projectId });
    prompts.softDelete(p2.id);

    const result = prompts.searchByScope({ scope: projectScope(projectId) });
    expect(result.prompts.map((p) => p.id)).toEqual([p1.id]);
  });

  it('includes soft-deleted prompts when includeDeleted is true', () => {
    const p1 = prompts.save({ content: 'keep', title: 'keep', projectId });
    const p2 = prompts.save({ content: 'drop', title: 'drop', projectId });
    prompts.softDelete(p2.id);

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      includeDeleted: true,
    });
    expect(result.prompts.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
  });

  it('does not leak prompts from other projects', () => {
    const otherProjectId = projects.create({ slug: 'other-project' }).id;
    prompts.save({
      content: 'foreign deploy',
      title: 'foreign deploy',
      projectId: otherProjectId,
    });
    prompts.save({ content: 'local deploy', title: 'local deploy', projectId });

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      query: 'deploy',
    });
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.content).toBe('local deploy');
  });

  it('global scope only sees prompts with NULL project_id', () => {
    prompts.save({ content: 'project-scoped', title: 'project-scoped', projectId });
    prompts.save({ content: 'global', title: 'global', projectId: null });

    const result = prompts.searchByScope({ scope: SCOPE_GLOBAL });
    expect(result.prompts.map((p) => p.content)).toEqual(['global']);
  });

  it('clamps limit and reports clamped:true', () => {
    prompts.save({ content: 'x', title: 'x', projectId });

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      limit: 500,
    });
    expect(result.clamped).toBe(true);
  });

  it('honours agent filter', () => {
    prompts.save({ content: 'p1', title: 'p1', projectId, agent: 'claude-code' });
    prompts.save({ content: 'p2', title: 'p2', projectId, agent: 'claude-code' });
    prompts.save({ content: 'p3', title: 'p3', projectId, agent: 'codex' });

    const result = prompts.searchByScope({
      scope: projectScope(projectId),
      agent: 'claude-code',
    });
    expect(result.prompts.map((p) => p.content).sort()).toEqual(['p1', 'p2'].sort());
  });
});

describe('PromptsService.countPurgeableDeleted', () => {
  it('counts only rows with deleted_at IS NOT NULL', () => {
    prompts.save({ content: 'a', title: 'a', projectId });
    const b = prompts.save({ content: 'b', title: 'b', projectId });
    prompts.softDelete(b.id);
    expect(prompts.countPurgeableDeleted()).toBe(1);
  });
});
