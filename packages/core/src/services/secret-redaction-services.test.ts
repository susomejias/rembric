import { createRepositories, projectScope, tokens as tokensSchema, type Scope } from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestDb,
  fakeGithubToken,
  fakeJwt,
  fakePemBlock,
  type TestDb,
} from '../test-support/index.js';

import { AgentSessionsService } from './agent-sessions.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { PromptsService } from './prompts.js';
import { RelationsService } from './relations.js';
import { RedactionTally } from './secret-redaction.js';
import { TokensService } from './tokens.js';

const GH = fakeGithubToken(101);
const GH_2 = fakeGithubToken(102);
const JWT = fakeJwt(103);
const PEM = fakePemBlock('PRIVATE KEY', 104);

let db: TestDb;
let memory: MemoryService;
let sessions: AgentSessionsService;
let prompts: PromptsService;
let relations: RelationsService;
let scope: Scope;
let tokenId: string;

beforeEach(() => {
  db = createTestDb();
  const repos = createRepositories(db.handle.db);
  memory = new MemoryService(repos, db.handle.db);
  sessions = new AgentSessionsService(repos, db.handle.db);
  prompts = new PromptsService(repos, db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  scope = projectScope(new ProjectsService(repos).create({ slug: 'redaction' }).id);
  new TokensService(repos, db.handle.db).bootstrapAdmin('test-admin-token-with-enough-entropy');
  tokenId = db.handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get()!
    .id;
});

afterEach(() => db.cleanup());

function saveMemory(label: string): string {
  return memory.save({ type: 'project', title: label, content: label }, scope).id;
}

describe('MemoryService.saveWithTopicKey', () => {
  it('stores title, content, tags and topic_key redacted and reports the kinds', () => {
    const tally = new RedactionTally();
    const { memory: m } = memory.saveWithTopicKey(
      {
        type: 'project',
        title: `rotated ${GH}`,
        content: `old: ${GH}\nnew key:\n${PEM}`,
        tags: ['deploy', GH_2],
        topicKey: `creds/${GH}`,
      },
      scope,
      tally,
    );
    expect(m.title).toBe('rotated [REDACTED:github_token]');
    expect(m.content).toBe('old: [REDACTED:github_token]\nnew key:\n[REDACTED:private_key]');
    expect(m.tags).toEqual(['deploy', 'redactedgithub-token']);
    expect(m.topicKey).toBe('creds/[REDACTED:github_token]');
    expect(tally.list()).toEqual([
      { kind: 'private_key', count: 1 },
      { kind: 'github_token', count: 4 },
    ]);
  });

  it('quotes the redacted topic_key in the upsert relation reason', () => {
    memory.saveWithTopicKey(
      { type: 'project', title: 'v1', content: 'v1', topicKey: `k/${GH}` },
      scope,
    );
    memory.saveWithTopicKey(
      { type: 'project', title: 'v2', content: 'v2', topicKey: `k/${GH}` },
      scope,
    );
    const reasons = db.handle.raw.prepare('SELECT reason FROM memory_relations').all() as {
      reason: string;
    }[];
    expect(reasons).toEqual([{ reason: "topic_key='k/[REDACTED:github_token]' upsert" }]);
  });

  it('cuts a title a placeholder lengthens past the cap', () => {
    const title = `${'t'.repeat(80)} password="hunter22"`;
    expect(title).toHaveLength(100);
    const { memory: m } = memory.saveWithTopicKey({ type: 'project', title, content: 'c' }, scope);
    expect(m.title).toHaveLength(100);
    expect(m.title).not.toContain('hunter22');
  });

  it('still validates the title as sent', () => {
    expect(() =>
      memory.save({ type: 'project', title: `${'t'.repeat(60)} ${GH}`, content: 'c' }, scope),
    ).toThrowError(expect.objectContaining({ code: 'invalid_input' }) as Error);
  });
});

describe('MemoryService.confirm', () => {
  it('redacts the reason of both verdicts', () => {
    const id = saveMemory('fact');
    memory.confirm(id, scope, { verdict: 'refute', reason: `leaked ${JWT}` });
    memory.confirm(id, scope, { verdict: 'affirm', reason: `still true, ${GH}` });
    const reasons = db.handle.raw
      .prepare('SELECT reason FROM confirmations WHERE memory_id = ? ORDER BY event_ts, id')
      .all(id) as { reason: string }[];
    expect(reasons.map((r) => r.reason)).toEqual([
      'leaked [REDACTED:jwt]',
      'still true, [REDACTED:github_token]',
    ]);
  });

  it('confirmMany redacts the shared reason once and reports it once', () => {
    const ids = [saveMemory('a'), saveMemory('b')];
    const tally = new RedactionTally();
    memory.confirmMany(ids, scope, { verdict: 'affirm', reason: GH }, tally);
    expect(tally.list()).toEqual([{ kind: 'github_token', count: 1 }]);
    const stored = db.handle.raw.prepare('SELECT reason FROM confirmations').all() as {
      reason: string;
    }[];
    expect(stored.map((r) => r.reason)).toEqual([
      '[REDACTED:github_token]',
      '[REDACTED:github_token]',
    ]);
  });
});

describe('AgentSessionsService', () => {
  it('start and ensure redact agent and description', () => {
    const tally = new RedactionTally();
    const started = sessions.start(
      { tokenId, projectId: scope.projectId, agent: 'cli', description: `token ${GH}` },
      tally,
    );
    const ensured = sessions.ensure({
      id: 'session-redaction-1',
      tokenId,
      projectId: scope.projectId,
      agent: `agent ${GH_2}`,
      description: null,
    }).session;
    expect(started.description).toBe('token [REDACTED:github_token]');
    expect(ensured.agent).toBe('agent [REDACTED:github_token]');
    expect(tally.list()).toEqual([{ kind: 'github_token', count: 1 }]);
  });

  it('writeSummary, end and reportTurn redact summary and title', () => {
    const a = sessions.start({ tokenId, projectId: scope.projectId, agent: 'cli' });
    const tally = new RedactionTally();
    const written = sessions.writeSummary(
      a.id,
      { tokenId, summary: `## Goal\nuse ${JWT}`, title: `t ${GH}`, final: true },
      tally,
    ).row;
    expect(written.summary).toBe('## Goal\nuse [REDACTED:jwt]');
    expect(written.title).toBe('t [REDACTED:github_token]');
    expect(tally.list()).toEqual([
      { kind: 'jwt', count: 1 },
      { kind: 'github_token', count: 1 },
    ]);

    const b = sessions.start({ tokenId, projectId: scope.projectId, agent: 'cli' });
    expect(sessions.reportTurn(b.id, { tokenId, usedTools: false, title: GH }).session.title).toBe(
      '[REDACTED:github_token]',
    );
    expect(sessions.end(b.id, { tokenId, summary: `done ${GH_2}` }).row.summary).toBe(
      'done [REDACTED:github_token]',
    );
  });

  it('redacts a summary written onto an already-ended session', () => {
    const s = sessions.start({ tokenId, projectId: scope.projectId, agent: 'cli' });
    sessions.end(s.id, { tokenId });
    const { row } = sessions.writeSummary(s.id, { tokenId, summary: `late ${GH}`, final: true });
    expect(row.summary).toBe('late [REDACTED:github_token]');
  });
});

describe('PromptsService.save', () => {
  it('redacts content, title and tags on insert and refine', () => {
    const tally = new RedactionTally();
    const first = prompts.save(
      { content: `run with ${GH}`, title: `p ${GH_2}`, tags: [JWT], projectId: scope.projectId },
      tally,
    );
    expect(first.content).toBe('run with [REDACTED:github_token]');
    expect(first.title).toBe('p [REDACTED:github_token]');
    expect(first.tags).toEqual(['[REDACTED:jwt]']);
    expect(tally.list()).toEqual([
      { kind: 'jwt', count: 1 },
      { kind: 'github_token', count: 2 },
    ]);
    const refined = prompts.save({
      content: `again ${GH}`,
      title: 'p2',
      projectId: scope.projectId,
      replaces: first.id,
    });
    expect(refined.content).toBe('again [REDACTED:github_token]');
  });
});

describe('RelationsService', () => {
  it('judgeInScope redacts the reason and every evidence string', () => {
    const source = saveMemory('source');
    const target = saveMemory('target');
    const pending = relations.createPending({ sourceId: source, targetId: target });
    const tally = new RedactionTally();
    const judged = relations.judgeInScope(
      pending.judgmentId,
      scope,
      {
        relation: 'related',
        reason: `see ${GH}`,
        evidence: { quotes: [JWT, { nested: GH_2 }], n: 3 },
        actor: 'agent',
        kind: 'agent',
      },
      tally,
    );
    expect(judged.reason).toBe('see [REDACTED:github_token]');
    expect(judged.evidence).toEqual({
      quotes: ['[REDACTED:jwt]', { nested: '[REDACTED:github_token]' }],
      n: 3,
    });
    expect(tally.list()).toEqual([
      { kind: 'jwt', count: 1 },
      { kind: 'github_token', count: 2 },
    ]);
  });

  it('compareInScope redacts on both the insert and the re-judge path', () => {
    const a = saveMemory('a');
    const b = saveMemory('b');
    const input = { sourceId: a, targetId: b, confidence: 0.9, actor: 'agent' } as const;
    const inserted = relations.compareInScope(
      { ...input, relation: 'related', reason: GH, evidence: JWT },
      scope,
    );
    expect([inserted.reason, inserted.evidence]).toEqual([
      '[REDACTED:github_token]',
      '[REDACTED:jwt]',
    ]);
    const rejudged = relations.compareInScope(
      { ...input, relation: 'compatible', reason: `again ${GH_2}` },
      scope,
    );
    expect(rejudged.reason).toBe('again [REDACTED:github_token]');
  });
});
