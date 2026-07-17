import { describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/db.js';

import { MemoryRepository } from './repositories/memory-repository.js';
import { PromptsRepository } from './repositories/prompts-repository.js';
import { memory, type NewMemory } from './schema/memory.js';
import { prompts, type NewPrompt } from './schema/prompts.js';

/**
 * 0020_fix_fts_delete_triggers — dangling-posting fix + memory_au write-amp fix.
 */

function mem(overrides: Partial<NewMemory> & { id: string }): NewMemory {
  return {
    title: 't',
    content: 'c',
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
    ...overrides,
  };
}

function prompt(overrides: Partial<NewPrompt> & { id: string; content: string }): NewPrompt {
  return {
    title: 't',
    createdAt: new Date(1_000),
    ...overrides,
  };
}

function ftsMatchCount(t: TestDb, table: 'memory_fts' | 'prompts_fts', term: string): number {
  const row = t.handle.raw
    .prepare<[string], { c: number }>(`SELECT count(*) c FROM ${table} WHERE ${table} MATCH ?`)
    .get(term);
  return row?.c ?? 0;
}

describe('migration 0020_fix_fts_delete_triggers', () => {
  it('a physical purge of a tagged archived memory leaves no dangling FTS posting', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M1', status: 'archived', tags: ['postgres'] })])
        .run();
      const repo = new MemoryRepository(t.handle.db);
      expect(ftsMatchCount(t, 'memory_fts', 'postgres')).toBe(1);

      repo.purgeByIds(['M1']);
      expect(ftsMatchCount(t, 'memory_fts', 'postgres')).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('rowid reuse after a purge does not resurrect the old tag as a phantom match', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M1', status: 'archived', tags: ['postgres'] })])
        .run();
      const repo = new MemoryRepository(t.handle.db);
      repo.purgeByIds(['M1']);

      // A fresh insert may reuse the freed rowid; it must not inherit M1's tag.
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M2', status: 'active', tags: ['redis'] })])
        .run();
      expect(ftsMatchCount(t, 'memory_fts', 'postgres')).toBe(0);
      expect(ftsMatchCount(t, 'memory_fts', 'redis')).toBe(1);
      t.handle.raw.prepare("INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')").run();
    } finally {
      t.cleanup();
    }
  });

  it('a last_seen_at-only touch does not rewrite the memory_fts postings', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M1', tags: ['k8s'] })])
        .run();
      const repo = new MemoryRepository(t.handle.db);
      expect(ftsMatchCount(t, 'memory_fts', 'k8s')).toBe(1);

      repo.touchLastSeenBatch(['M1'], new Date(5_000));
      repo.touchLastSeenBatch(['M1'], new Date(6_000));
      expect(ftsMatchCount(t, 'memory_fts', 'k8s')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('a real tags change still re-indexes memory_fts correctly', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M1', tags: ['old'] })])
        .run();
      t.handle.raw.prepare("UPDATE memory SET tags = '[\"new\"]' WHERE id = 'M1'").run();
      expect(ftsMatchCount(t, 'memory_fts', 'old')).toBe(0);
      expect(ftsMatchCount(t, 'memory_fts', 'new')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('a physical purge of a tagged prompt leaves no dangling FTS posting', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(prompts)
        .values([prompt({ id: 'P1', content: 'deploy notes', tags: ['docker'] })])
        .run();
      const repo = new PromptsRepository(t.handle.db);
      expect(ftsMatchCount(t, 'prompts_fts', 'docker')).toBe(1);

      repo.purgeByIds(['P1']);
      expect(ftsMatchCount(t, 'prompts_fts', 'docker')).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('a deleted_at-only flip still leaves the prompt discoverable in prompts_fts (spec-required)', () => {
    const t = createTestDb();
    try {
      t.handle.db
        .insert(prompts)
        .values([prompt({ id: 'P1', content: 'other notes', tags: ['redis'] })])
        .run();
      expect(ftsMatchCount(t, 'prompts_fts', 'redis')).toBe(1);

      t.handle.raw.prepare("UPDATE prompts SET deleted_at = 500 WHERE id = 'P1'").run();
      expect(ftsMatchCount(t, 'prompts_fts', 'redis')).toBe(1);
    } finally {
      t.cleanup();
    }
  });
});
