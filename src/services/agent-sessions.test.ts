import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { AgentSessionsService } from './agent-sessions.js';
import { ProjectsService } from './projects.js';
import { TokensService } from './tokens.js';

let db: TestDb;
let sessions: AgentSessionsService;
let projects: ProjectsService;
let tokens: TokensService;
let tokenId: string;
let otherTokenId: string;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  sessions = new AgentSessionsService(db.handle.db);
  projects = new ProjectsService(db.handle.db);
  tokens = new TokensService(db.handle.db);

  tokens.bootstrapAdmin('test-admin-token-with-enough-entropy');
  const admin = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get();
  tokenId = admin!.id;

  const { token: other } = tokens.create({ name: 'other-agent', scope: '*' });
  otherTokenId = other.id;

  projectId = projects.create({ slug: 'lifecycle-tests' }).id;
});

afterEach(() => db.cleanup());

describe('AgentSessionsService', () => {
  it('start inserts an active row with the provided fields', () => {
    const s = sessions.start({
      tokenId,
      projectId,
      agent: 'claude-code',
      description: 'wire the test',
    });
    expect(s.status).toBe('active');
    expect(s.agent).toBe('claude-code');
    expect(s.projectId).toBe(projectId);
    expect(s.description).toBe('wire the test');
    expect(s.endedAt).toBeNull();
    expect(s.summary).toBeNull();
  });

  it('end transitions to ended without writing summary', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const ended = sessions.end(s.id, { tokenId });
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBeNull();
  });

  it('summarize transitions to ended and persists the summary', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const updated = sessions.summarize(s.id, {
      tokenId,
      summary: '## Goal\nwrap it up',
    });
    expect(updated.status).toBe('ended');
    expect(updated.summary).toBe('## Goal\nwrap it up');
    expect(updated.endedAt).not.toBeNull();
  });

  it('refuses end from a different token (masks as session_not_found)', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.end(s.id, { tokenId: otherTokenId })).toThrow(/not found/i);
  });

  it('refuses summarize from a different token (masks as session_not_found)', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.summarize(s.id, { tokenId: otherTokenId, summary: 'x' })).toThrow(
      /not found/i,
    );
  });

  it('refuses double-end with session_already_ended', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    sessions.end(s.id, { tokenId });
    expect(() => sessions.end(s.id, { tokenId })).toThrow(/already/i);
  });

  it('summarize rejects an empty summary string', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.summarize(s.id, { tokenId, summary: '   ' })).toThrow(/non-empty/);
  });

  it('findActiveForTransport returns the most recent active session for the pair', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    // Sleep so b's startedAt > a's startedAt.
    const b = sessions.start({ tokenId, projectId, agent: 'b' });
    const found = sessions.findActiveForTransport({ tokenId, projectId });
    expect(found?.id).toBe(b.id);
    expect(found?.id).not.toBe(a.id);
  });

  it('findActiveForTransport returns null when the token has no active session', () => {
    expect(sessions.findActiveForTransport({ tokenId, projectId })).toBeNull();
  });

  it('abandonStale flips old active rows to abandoned', () => {
    const old = sessions.start({ tokenId, projectId, agent: 'old' });
    // Backdate started_at by 48h via raw SQL so abandonStale picks it up.
    db.handle.raw
      .prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 2 * 24 * 3600 * 1000, old.id);

    const result = sessions.abandonStale({ olderThanMs: 24 * 3600 * 1000 });
    expect(result.abandoned).toBe(1);
    expect(sessions.getById(old.id)?.status).toBe('abandoned');
  });

  it('countByStatus returns counts grouped by status', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    sessions.start({ tokenId, projectId, agent: 'b' });
    sessions.end(a.id, { tokenId });
    const counts = sessions.countByStatus();
    expect(counts.active).toBe(1);
    expect(counts.ended).toBe(1);
    expect(counts.abandoned).toBe(0);
  });
});
