import { createRepositories, memory, projectScope, tokens as tokensSchema } from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentSessionsService,
  extractEntities,
  FILE_RECALL_FILES_PER_SESSION,
  MemoryService,
  ProjectsService,
  TokensService,
  type SaveMemoryInput,
} from '@rembric/core';

import { createTestDb, type TestDb } from '../test-support/index.js';

const DAY = 86_400_000;

let db: TestDb;
let clock: Date;
let sessions: AgentSessionsService;
let memories: MemoryService;
let repos: ReturnType<typeof createRepositories>;
let tokenId: string;
let projectId: string;
let caller: string;
let other: string;

beforeEach(() => {
  db = createTestDb();
  clock = new Date('2026-11-01T10:00:00Z');
  repos = createRepositories(db.handle.db);
  sessions = new AgentSessionsService(repos, db.handle.db, () => clock);
  memories = new MemoryService(repos, db.handle.db, () => clock);
  new TokensService(repos, db.handle.db).bootstrapAdmin('test-admin-token-with-enough-entropy');
  tokenId = db.handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get()!
    .id;
  projectId = new ProjectsService(repos).create({ slug: 'file-recall-tests' }).id;
  caller = sessions.start({ tokenId, projectId, agent: 'claude-code' }).id;
  other = sessions.start({ tokenId, projectId, agent: 'claude-code' }).id;
});

afterEach(() => db.cleanup());

function save(content: string, over: Partial<SaveMemoryInput> = {}): string {
  const input: SaveMemoryInput = {
    type: 'project',
    title: over.title ?? content.slice(0, 60),
    content,
    sessionId: other,
    ...over,
  };
  const saved = memories.save(input, projectScope(projectId));
  repos.entities.linkMemory(
    saved.id,
    projectId,
    extractEntities(input.title, input.content),
    clock,
  );
  return saved.id;
}

const recall = (path: string, siblings?: string[], session = caller) =>
  sessions.fileRecall(session, { path, ...(siblings && { siblings }) });

describe('AgentSessionsService.fileRecall', () => {
  it('returns a memory linked to the file, and does not count the notice as a read', () => {
    const id = save('migrations run in packages/db/src/migrate.ts inside BEGIN IMMEDIATE');
    const before = repos.memory.unsafeGetById(id)!.lastSeenAt;
    clock = new Date(clock.getTime() + 1000);
    const { lines, exhausted } = recall('packages/db/src/migrate.ts');
    expect(lines[0]).toBe('rembric: memories about packages/db/src/migrate.ts:');
    expect(lines[1]).toContain(`[${id}]`);
    expect(exhausted).toBe(false);
    expect(before).not.toBeNull();
    expect(repos.memory.unsafeGetById(id)!.lastSeenAt?.getTime()).toBe(before?.getTime());
  });

  it('skips archived, reference and own-session memories, with an eligible control', () => {
    const control = save('control about src/x.ts');
    const archived = save('archived about src/x.ts');
    db.handle.db.update(memory).set({ status: 'archived' }).where(eq(memory.id, archived)).run();
    save('reference about src/x.ts', { type: 'reference' });
    save('own note about src/x.ts', { sessionId: caller });
    const text = recall('src/x.ts').lines.join('\n');
    expect(text).toContain(`[${control}]`);
    expect(text.match(/\[/g)).toHaveLength(1);
  });

  it('normalises the requested path the way entities are stored', () => {
    const id = save('about src/x.ts');
    expect(recall('./src//x.ts').lines.join('\n')).toContain(`[${id}]`);
  });

  it('refuses a path that is not repo-relative, even when its suffix would match', () => {
    save('about src/x.ts');
    for (const path of ['/abs/src/x.ts', '../src/x.ts', '']) {
      expect(recall(path, [path]), path).toEqual({ lines: [], exhausted: false });
    }
  });

  it('matches a unique suffix only when the siblings prove it unique', () => {
    const id = save('partial path services/review.ts is the review clock');
    const path = 'packages/core/src/services/review.ts';
    expect(recall(path).lines).toEqual([]);
    expect(recall(path, [path, 'apps/web/src/services/review.ts']).lines).toEqual([]);
    expect(recall(path, [path]).lines.join('\n')).toContain(`[${id}]`);
  });

  it('renders at most three memories for one file, keeping the rest for later', () => {
    const ids = [1, 2, 3, 4].map((i) => save(`fact ${i} about src/many.ts`));
    const first = recall('src/many.ts').lines.filter((l) => l.startsWith('- '));
    expect(first).toHaveLength(3);
    sessions.resume(caller, { tokenId });
    const shown = recall('src/many.ts').lines.join('\n');
    expect(ids.filter((id) => shown.includes(`[${id}]`))).toHaveLength(3);
  });

  it('returns a memory once per session even when it names two files', () => {
    const id = save('src/a.ts and lib/b.ts share the codec');
    expect(recall('src/a.ts').lines.join('\n')).toContain(`[${id}]`);
    expect(recall('lib/b.ts')).toEqual({ lines: [], exhausted: false });
  });

  it('stops after the per-session cap and says so', () => {
    for (let i = 0; i <= FILE_RECALL_FILES_PER_SESSION; i++) save(`note about src/f${i}.ts`);
    for (let i = 0; i < FILE_RECALL_FILES_PER_SESSION; i++) {
      const r = recall(`src/f${i}.ts`);
      expect(r.lines.length).toBeGreaterThan(0);
      expect(r.exhausted).toBe(i === FILE_RECALL_FILES_PER_SESSION - 1);
    }
    expect(recall(`src/f${FILE_RECALL_FILES_PER_SESSION}.ts`)).toEqual({
      lines: [],
      exhausted: true,
    });
  });

  it('releases the session state on resume, even on an already-active session', () => {
    const id = save('about src/r.ts');
    expect(recall('src/r.ts').lines.join('\n')).toContain(`[${id}]`);
    expect(recall('src/r.ts').lines).toEqual([]);
    sessions.resume(caller, { tokenId });
    expect(recall('src/r.ts').lines.join('\n')).toContain(`[${id}]`);
  });

  it('releases the session state when the session ends', () => {
    const id = save('about src/e.ts');
    expect(recall('src/e.ts').lines.length).toBeGreaterThan(0);
    sessions.end(caller, { tokenId });
    expect(recall('src/e.ts').lines.join('\n')).toContain(`[${id}]`);
  });

  it('marks a memory past its review shelf life', () => {
    save('old fact about src/old.ts');
    clock = new Date(clock.getTime() + 120 * DAY);
    expect(recall('src/old.ts').lines[1]).toMatch(/\(2026-11-01, needs review\)$/);
  });

  it('answers an unknown session with nothing', () => {
    save('about src/x.ts');
    expect(recall('src/x.ts', undefined, 'no-such-session')).toEqual({
      lines: [],
      exhausted: false,
    });
  });
});
