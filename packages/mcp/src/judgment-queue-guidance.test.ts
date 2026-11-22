import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  AgentSessionsService,
  MemoryService,
  ProjectsService,
  PromptsService,
  RelationsService,
  RepositoryBindingsService,
} from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInstructions,
  createMcpServer,
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
  type DoctorReport,
} from '@rembric/mcp';

import { createTestDb, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

const DOCTOR: DoctorReport = {
  db: { journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
  embeddings: { model: 'test', backlog: 0 },
  entities: { backlog: 0 },
  consolidation: { lastRunAt: null, lastRunOps: {} },
  sessions: { active: 0 },
  review: { needsReview: 0, pendingJudgments: 0 },
  warnings: [],
};

const JUDGE_STEP = 'memory.judge_batch({judgments:[…]})';

describe('instructions with the judgment queue disabled', () => {
  const variants = [
    { requestedSlug: null },
    { requestedSlug: 'rembric' },
    { requestedSlug: null, unbound: true },
    { requestedSlug: 'x'.repeat(64) },
  ];

  it.each(variants)('names memory.compare for the two effect verdicts (%o)', (ctx) => {
    const text = buildInstructions({ ...ctx, judgmentQueue: false });
    expect(text).toContain('memory.compare');
    expect(text).toContain('supersedes');
    expect(text).toContain('conflicts_with');
    expect(text).not.toContain(JUDGE_STEP);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
  });

  it.each(variants)('keeps the published guidance when the queue is enabled (%o)', (ctx) => {
    const enabled = buildInstructions({ ...ctx, judgmentQueue: true });
    expect(enabled).toContain(JUDGE_STEP);
    expect(enabled).toBe(buildInstructions(ctx));
  });
});

describe('tool descriptions with the judgment queue disabled', () => {
  let db: TestDb;
  let client: Client;

  async function descriptions(persist?: boolean): Promise<Map<string, string>> {
    db = createTestDb();
    const repos = createRepositories(db.handle.db);
    const server = createMcpServer({
      memory: new MemoryService(repos, db.handle.db),
      projects: new ProjectsService(repos),
      agentSessions: new AgentSessionsService(repos, db.handle.db),
      prompts: new PromptsService(repos, db.handle.db),
      relations: new RelationsService(repos, db.handle.db),
      repositoryBindings: new RepositoryBindingsService(repos, db.handle.db),
      candidates: { perSaveMax: 5, ...(persist === undefined ? {} : { persist }) },
      repos,
      doctor: () => DOCTOR,
      logInternalError,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? '']));
  }

  afterEach(async () => {
    await client.close();
    db.cleanup();
  });

  it('memory.save, memory.capture_passive and memory.merge send the agent to memory.compare', async () => {
    const d = await descriptions(false);
    for (const name of [
      'memory.save',
      'memory.capture_passive',
      'memory.merge',
      'memory.search',
      'memory.archive',
    ]) {
      const text = d.get(name)!;
      expect(text, name).not.toContain('memory.judge_batch');
      expect(text.length, name).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    }
    expect(d.get('memory.save')).toContain('memory.compare');
    expect(d.get('memory.save')).toContain('conflicts_with');
    expect(d.get('memory.save')).toContain('converge: true');
  });

  it('memory.compare names the candidate pair instead of memory.judge_batch', async () => {
    const text = (await descriptions(false)).get('memory.compare')!;
    expect(text).toContain('sourceId');
    expect(text).not.toContain('memory.judge_batch');
  });

  it('memory.judge_batch and memory.context say pending judgments predate the switch', async () => {
    const d = await descriptions(false);
    for (const name of ['memory.judge_batch', 'memory.context']) {
      const text = d.get(name)!;
      expect(text, name).toContain('before the judgment queue was disabled');
      expect(text.length, name).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    }
  });

  it('an enabled or unset queue keeps every published description', async () => {
    const unset = await descriptions();
    await client.close();
    db.cleanup();
    const enabled = await descriptions(true);
    expect([...enabled]).toEqual([...unset]);
    expect(unset.get('memory.save')).toContain('memory.judge_batch');
    expect(unset.get('memory.context')).not.toContain('before the judgment queue was disabled');
  });
});
