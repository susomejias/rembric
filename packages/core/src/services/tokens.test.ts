import { createRepositories, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  OAuthService,
  isAuthorized,
  SessionsService,
  ProjectsService,
  pinnedProjectId,
  TokensService,
  type CreateTokenInput,
  type TokenReach,
  type TokenScope,
} from '@rembric/core';

import { createTestDb, type TestDb } from '../test-support/index.js';

let db: TestDb;
let tokens: TokensService;

beforeEach(() => {
  db = createTestDb();
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);
});

afterEach(() => {
  db.cleanup();
});

describe('TokensService.deleteRevoked', () => {
  it('hides only the target, retains names and counts, and rejects warm and cold bearer access', async () => {
    const target = tokens.create({ name: 'removed', scope: '*' });
    const other = tokens.create({ name: 'kept', scope: '*' });
    await tokens.authenticate(target.plaintext);
    tokens.revoke(target.token.name);
    tokens.deleteRevoked(target.token.id);
    expect(tokens.list().map((row) => row.id)).toEqual([other.token.id]);
    expect(tokens.findById(target.token.id)?.deletedAt).toBeInstanceOf(Date);
    expect(tokens.findByName('removed')?.id).toBe(target.token.id);
    expect(tokens.count()).toBe(2);
    expect(() => tokens.create({ name: 'removed', scope: '*' })).toThrow(/already exists/);
    await expect(tokens.authenticate(target.plaintext)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    const cold = new TokensService(createRepositories(db.handle.db), db.handle.db);
    await expect(cold.authenticate(target.plaintext)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await expect(tokens.authenticate(other.plaintext)).resolves.toMatchObject({
      token: { id: other.token.id },
    });
  });

  it('does not bootstrap after the last visible token is deleted', () => {
    const target = tokens.create({ name: 'last', scope: '*' });
    tokens.revoke('last');
    tokens.deleteRevoked(target.token.id);
    expect(tokens.list()).toEqual([]);
    tokens.bootstrapAdmin('replacement-bootstrap-token');
    expect(tokens.count()).toBe(1);
    expect(tokens.findByName('admin')).toBeUndefined();
  });

  it('refuses empty, missing, and already deleted IDs', () => {
    expect(() => tokens.deleteRevoked('   ')).toThrow(
      new DomainError('invalid_input', 'tokens.delete: id must be non-empty'),
    );
    expect(() => tokens.deleteRevoked('missing')).toThrow(
      new DomainError('token_not_found', 'tokens.delete: token not found or already deleted'),
    );
    const target = tokens.create({ name: 'repeat', scope: '*' });
    tokens.revoke('repeat');
    tokens.deleteRevoked(target.token.id);
    const deletedAt = tokens.findById(target.token.id)?.deletedAt;
    expect(() => tokens.deleteRevoked(target.token.id)).toThrow(
      new DomainError('token_not_found', 'tokens.delete: token not found or already deleted'),
    );
    expect(tokens.findById(target.token.id)?.deletedAt).toEqual(deletedAt);
  });

  it.each([null, new Date(0)])('refuses unrevoked tokens regardless of expiry %s', (expiresAt) => {
    const target = tokens.create({ name: 'unrevoked', scope: '*', expiresAt });
    expect(() => tokens.deleteRevoked(target.token.id)).toThrow(
      new DomainError('invalid_input', 'tokens.delete: revoke the token before deleting it'),
    );
    expect(tokens.list().map((row) => row.id)).toContain(target.token.id);
    expect(tokens.findById(target.token.id)?.deletedAt).toBeNull();
  });

  it('conditionally updates only revoked, undeleted repository rows', () => {
    const repo = createRepositories(db.handle.db).tokens;
    const target = tokens.create({ name: 'conditional', scope: '*' });
    const other = tokens.create({ name: 'conditional-control', scope: '*' });
    tokens.revoke(other.token.name);
    expect(repo.deleteRevoked(target.token.id, new Date())).toBe(0);
    expect(repo.deleteRevoked('missing', new Date())).toBe(0);
    tokens.revoke('conditional');
    expect(repo.deleteRevoked(target.token.id, new Date(1000))).toBe(1);
    expect(repo.deleteRevoked(target.token.id, new Date(2000))).toBe(0);
    expect(tokens.findById(target.token.id)?.deletedAt).toEqual(new Date(1000));
    expect(tokens.findById(other.token.id)?.deletedAt).toBeNull();
  });

  it('retains project memberships and agent session provenance', () => {
    const repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    const first = projects.create({ slug: 'history-first' });
    const second = projects.create({ slug: 'history-second' });
    const target = tokens.create({ name: 'history', projects: [first, second], access: 'write' });
    const session = repos.agentSessions.insert({
      id: 'history-session',
      tokenId: target.token.id,
      projectId: first.id,
      agent: 'test',
      startedAt: new Date(),
      summary: 'retained summary',
      status: 'ended',
    });
    expect(session).toBeDefined();
    const memberships = repos.tokens.listProjectIds(target.token.id);
    expect(memberships).toHaveLength(2);
    tokens.revoke('history');
    tokens.deleteRevoked(target.token.id);
    expect(repos.tokens.listProjectIds(target.token.id)).toEqual(memberships);
    expect(repos.agentSessions.getById('history-session')).toEqual(session);
    expect(tokens.findById(target.token.id)?.name).toBe('history');
  });

  it('invalidates every linked dashboard cookie while retaining unrelated access', () => {
    const repos = createRepositories(db.handle.db);
    const target = tokens.create({ name: 'cookie-target', scope: '*' });
    const other = tokens.create({ name: 'cookie-other', scope: '*' });
    const sessions = new SessionsService(repos, Buffer.alloc(32, 1));
    const first = sessions.create(target.token.id);
    const second = sessions.create(target.token.id);
    const control = sessions.create(other.token.id);
    expect(sessions.resolve(first.cookie)?.tokenId).toBe(target.token.id);
    expect(sessions.resolve(second.cookie)?.tokenId).toBe(target.token.id);
    tokens.revoke(target.token.name);
    tokens.deleteRevoked(target.token.id);
    expect(sessions.resolve(first.cookie)).toBeNull();
    expect(sessions.resolve(second.cookie)).toBeNull();
    expect(sessions.resolve(control.cookie)?.tokenId).toBe(other.token.id);
    expect(tokens.findById(target.token.id)?.hash).toBe(target.token.hash);
  });
});

describe('TokensService.promoteToAdmin', () => {
  it.each(['read-all', 'single', 'read-single', 'set', 'read-set'] as const)(
    'promotes %s with the warmed same secret, preserving identity, history and other tokens',
    async (kind) => {
      const repos = createRepositories(db.handle.db);
      const service = new TokensService(repos, db.handle.db);
      const projects = new ProjectsService(repos);
      const first = projects.create({ slug: 'promotion-first' });
      const second = projects.create({ slug: 'promotion-second' });
      const grant: CreateTokenInput =
        kind === 'read-all'
          ? { name: 'promoted', scope: 'read:*' }
          : {
              name: 'promoted',
              projects: kind.includes('set') ? [first, second] : [first],
              access: kind.startsWith('read') ? 'read' : 'write',
            };
      const target = service.create({ ...grant, expiresAt: new Date('2099-01-01') });
      const control = service.create({
        name: 'untouched',
        projects: [first, second],
        access: 'read',
      });
      const controlMembers = repos.tokens.listProjectIds(control.token.id);
      const session = repos.agentSessions.insert({
        id: 'promotion-history',
        tokenId: target.token.id,
        projectId: first.id,
        agent: 'test',
        startedAt: new Date(),
        summary: 'history',
        status: 'ended',
      });
      const sessions = new SessionsService(repos, Buffer.alloc(32, 1));
      const dashboard = sessions.create(target.token.id);
      const dashboardBefore = db.handle.raw.prepare('SELECT * FROM dashboard_sessions').all();
      expect(dashboard.cookie).toBeTruthy();
      const before = await service.authenticate(target.plaintext);
      expect(isAuthorized(before, 'write', { scope: 'project', projectId: 'outside' })).toBe(false);
      const scans = vi.spyOn(repos.tokens, 'listAll');
      service.promoteToAdmin(target.token.id);
      const after = await service.authenticate(target.plaintext);
      expect(scans).not.toHaveBeenCalled();
      expect(after).toEqual({
        token: { ...target.token, scope: '*', projectId: null },
        scope: '*',
        memberProjectIds: [],
      });
      expect(isAuthorized(after, 'write', { scope: 'project', projectId: 'outside' })).toBe(true);
      expect(service.findById(control.token.id)).toEqual(control.token);
      expect(repos.tokens.listProjectIds(control.token.id)).toEqual(controlMembers);
      expect(repos.agentSessions.getById('promotion-history')).toEqual(session);
      expect(db.handle.raw.prepare('SELECT * FROM dashboard_sessions').all()).toEqual(
        dashboardBefore,
      );
    },
  );

  it.each([
    'blank',
    'missing',
    'deleted',
    'revoked',
    'expired',
    'at-now',
    'inert',
    'read-inert',
    'empty-set',
    'read-empty-set',
  ])('refuses %s without changing any row or memberships', (kind) => {
    const repos = createRepositories(db.handle.db);
    const now = new Date(10000);
    const service = new TokensService(repos, db.handle.db, () => now);
    const project = new ProjectsService(repos).create({ slug: 'eligible-control' });
    const control = service.create({ name: 'control', project, access: 'write' });
    const target = service.create({
      name: 'ineligible',
      scope: 'read:*',
      expiresAt: kind === 'expired' ? new Date(9999) : kind === 'at-now' ? now : null,
    });
    if (kind === 'revoked' || kind === 'deleted') service.revoke('ineligible');
    if (kind === 'deleted') service.deleteRevoked(target.token.id);
    if (kind.includes('inert') || kind.includes('empty-set')) {
      const scope =
        kind === 'inert'
          ? 'project:missing'
          : kind === 'read-inert'
            ? 'read:project:missing'
            : kind === 'empty-set'
              ? 'projects'
              : 'read:projects';
      db.handle.raw.prepare('UPDATE tokens SET scope = ? WHERE id = ?').run(scope, target.token.id);
    }
    const before = repos.tokens.listAll();
    const id = kind === 'blank' ? '   ' : kind === 'missing' ? 'missing' : target.token.id;
    const message =
      kind === 'blank'
        ? 'id must be non-empty'
        : kind === 'missing' || kind === 'deleted'
          ? 'token not found or deleted'
          : kind.includes('inert')
            ? 'unresolved project binding'
            : kind.includes('empty-set')
              ? 'token has no projects'
              : 'token must be active';
    expect(() => service.promoteToAdmin(id)).toThrow(message);
    expect(repos.tokens.listAll()).toEqual(before);
    expect(repos.tokens.listProjectIds(target.token.id)).toEqual([]);
    service.promoteToAdmin(control.token.id);
    expect(service.findById(control.token.id)?.scope).toBe('*');
  });

  it('checks lifecycle before the administrator idempotent no-op', () => {
    const target = tokens.create({ name: 'admin-noop', scope: '*' });
    db.handle.raw.exec(
      "CREATE TRIGGER refuse_admin_update BEFORE UPDATE OF scope ON tokens BEGIN SELECT RAISE(ABORT, 'admin must be a no-op'); END",
    );
    tokens.promoteToAdmin(target.token.id);
    expect(tokens.findById(target.token.id)).toEqual(target.token);
    tokens.revoke(target.token.name);
    expect(() => tokens.promoteToAdmin(target.token.id)).toThrow(DomainError);
  });

  it('rolls back the grant and memberships when cleanup fails', () => {
    const repos = createRepositories(db.handle.db);
    const service = new TokensService(repos, db.handle.db);
    const projects = new ProjectsService(repos);
    const first = projects.create({ slug: 'rollback-first' });
    const second = projects.create({ slug: 'rollback-second' });
    const target = service.create({ name: 'rollback', projects: [first, second], access: 'write' });
    const members = repos.tokens.listProjectIds(target.token.id);
    db.handle.raw.exec(
      "CREATE TRIGGER refuse_cleanup BEFORE DELETE ON token_projects BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END",
    );
    expect(() => service.promoteToAdmin(target.token.id)).toThrow('cleanup failed');
    expect(service.findById(target.token.id)).toEqual(target.token);
    expect(repos.tokens.listProjectIds(target.token.id)).toEqual(members);
  });

  it('refuses a failed conditional update before attempting cleanup', () => {
    const repos = createRepositories(db.handle.db);
    const service = new TokensService(repos, db.handle.db);
    const target = service.create({ name: 'failed-update', scope: 'read:*' });
    db.handle.raw.exec(
      'CREATE TRIGGER skip_promotion BEFORE UPDATE OF scope ON tokens BEGIN SELECT RAISE(IGNORE); END',
    );
    const cleanup = vi.spyOn(repos.tokens, 'deleteProjects');
    expect(() => service.promoteToAdmin(target.token.id)).toThrow(DomainError);
    expect(cleanup).not.toHaveBeenCalled();
    expect(service.findById(target.token.id)).toEqual(target.token);
  });

  it.each(['missing', 'deleted', 'revoked', 'expired', 'at-now', 'live', 'no-expiry'])(
    'repository conditional promotion handles %s independently',
    (kind) => {
      const repo = createRepositories(db.handle.db).tokens;
      const now = new Date(10000);
      const target = tokens.create({
        name: 'conditional-promotion',
        scope: 'read:*',
        expiresAt:
          kind === 'no-expiry'
            ? null
            : new Date(kind === 'expired' ? 9999 : kind === 'at-now' ? 10000 : 10001),
      });
      if (kind === 'revoked') tokens.revoke(target.token.name);
      if (kind === 'deleted')
        db.handle.raw
          .prepare('UPDATE tokens SET deleted_at = ? WHERE id = ?')
          .run(1, target.token.id);
      const before = tokens.findById(target.token.id);
      const eligible = kind === 'live' || kind === 'no-expiry';
      expect(repo.promoteToAdmin(kind === 'missing' ? 'missing' : target.token.id, now)).toBe(
        eligible ? 1 : 0,
      );
      expect(tokens.findById(target.token.id)).toEqual(
        eligible ? { ...before, scope: '*', projectId: null } : before,
      );
    },
  );
});

describe('TokensService.rotate', () => {
  it.each(['*', 'read:*', 'single', 'set'] as const)(
    'preserves %s identity and history while invalidating only linked credentials across instances',
    async (grant) => {
      const repos = createRepositories(db.handle.db);
      const service = new TokensService(repos, db.handle.db);
      const peer = new TokensService(repos, db.handle.db);
      const projects = new ProjectsService(repos);
      const first = projects.create({ slug: 'rotate-first' });
      const second = projects.create({ slug: 'rotate-second' });
      const target = service.create(
        grant === 'single' || grant === 'set'
          ? {
              name: 'rotate',
              projects: grant === 'set' ? [first, second] : [first],
              access: 'read',
              expiresAt: new Date('2099-01-01'),
            }
          : { name: 'rotate', scope: grant },
      );
      const other = service.create({ name: 'control', scope: '*' });
      const memberships = repos.tokens.listProjectIds(target.token.id);
      const history = repos.agentSessions.insert({
        id: 'rotation-history',
        tokenId: target.token.id,
        projectId: first.id,
        agent: 'test',
        startedAt: new Date(),
        status: 'ended',
        summary: 'history',
      });
      const sessions = new SessionsService(repos, Buffer.alloc(32, 1));
      const cookies = [sessions.create(target.token.id), sessions.create(target.token.id)];
      const controlCookie = sessions.create(other.token.id);
      const oauth = new OAuthService(repos, { accessTtlMs: 60000, refreshTtlMs: 120000 });
      const client = oauth.registerClient({ redirectUris: ['https://example.com/cb'] });
      const issue = (subject: string) =>
        oauth.issueCode({
          clientId: client.clientId,
          redirectUri: 'https://example.com/cb',
          codeChallenge: 'challenge',
          scope: 'mcp',
          subject,
        });
      const redeem = (code: string) =>
        oauth.redeemCode({
          code,
          clientId: client.clientId,
          redirectUri: 'https://example.com/cb',
        });
      const pair = redeem(issue(target.token.id));
      const pending = issue(target.token.id);
      const controlPair = redeem(issue(other.token.id));
      expect(oauth.challengeForCode(pending)).toBe('challenge');
      expect(oauth.authenticateAccessToken(pair.accessToken)).not.toBeNull();
      await service.authenticate(target.plaintext);
      await peer.authenticate(target.plaintext);
      const rotated = service.rotate(target.token.id);
      expect(rotated.plaintext).not.toBe(target.plaintext);
      expect(rotated.token.hash).not.toContain(rotated.plaintext);
      expect(rotated.token).toEqual({ ...target.token, hash: rotated.token.hash });
      expect(rotated.token.hash).not.toBe(target.token.hash);
      expect(repos.tokens.listProjectIds(target.token.id)).toEqual(memberships);
      expect(repos.agentSessions.getById('rotation-history')).toEqual(history);
      expect(service.findById(other.token.id)).toEqual(other.token);
      for (const instance of [service, peer]) {
        await expect(instance.authenticate(target.plaintext)).rejects.toThrow();
        await expect(instance.authenticate(rotated.plaintext)).resolves.toMatchObject({
          token: rotated.token,
        });
      }
      for (const cookie of cookies) expect(sessions.resolve(cookie.cookie)).toBeNull();
      expect(sessions.resolve(controlCookie.cookie)).not.toBeNull();
      expect(() => oauth.challengeForCode(pending)).toThrow();
      expect(() => redeem(pending)).toThrow();
      expect(() =>
        oauth.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId }),
      ).toThrow();
      expect(oauth.authenticateAccessToken(pair.accessToken)).toBeNull();
      expect(oauth.authenticateAccessToken(controlPair.accessToken)).not.toBeNull();
      expect(
        oauth.refresh({ refreshToken: controlPair.refreshToken, clientId: client.clientId })
          .accessToken,
      ).toBeTruthy();
    },
  );

  it.each([
    'blank',
    'missing',
    'deleted',
    'revoked',
    'expired',
    'at-now',
    'inert',
    'read-inert',
    'empty-set',
    'read-empty-set',
  ])('refuses %s rotation without mutation', (kind) => {
    const repos = createRepositories(db.handle.db);
    const now = new Date(10000);
    const service = new TokensService(repos, db.handle.db, () => now);
    const target = service.create({
      name: 'ineligible',
      scope: '*',
      expiresAt: kind === 'expired' ? new Date(9999) : kind === 'at-now' ? now : null,
    });
    if (kind === 'revoked' || kind === 'deleted') service.revoke('ineligible');
    if (kind === 'deleted') service.deleteRevoked(target.token.id);
    if (kind.includes('inert') || kind.includes('empty-set')) {
      const scope =
        kind === 'inert'
          ? 'project:missing'
          : kind === 'read-inert'
            ? 'read:project:missing'
            : kind === 'empty-set'
              ? 'projects'
              : 'read:projects';
      db.handle.raw.prepare('UPDATE tokens SET scope = ? WHERE id = ?').run(scope, target.token.id);
    }
    const before = repos.tokens.listAll();
    const replace = vi.spyOn(repos.tokens, 'replaceHash');
    const message =
      kind === 'blank'
        ? 'id must be non-empty'
        : kind === 'missing' || kind === 'deleted'
          ? 'token not found or deleted'
          : kind.includes('inert')
            ? 'unresolved project binding'
            : kind.includes('empty-set')
              ? 'token has no projects'
              : 'token must be active';
    expect(() =>
      service.rotate(kind === 'blank' ? ' ' : kind === 'missing' ? 'missing' : target.token.id),
    ).toThrow(message);
    expect(replace).not.toHaveBeenCalled();
    expect(repos.tokens.listAll()).toEqual(before);
  });

  it.each(['rotate', 'revoke', 'delete'] as const)(
    'rejects cold authentication overlapping %s',
    async (operation) => {
      const target = tokens.create({ name: 'race', scope: '*' });
      const pending = tokens.authenticate(target.plaintext);
      if (operation === 'rotate') tokens.rotate(target.token.id);
      else {
        tokens.revoke(target.token.name);
        if (operation === 'delete') tokens.deleteRevoked(target.token.id);
      }
      await expect(pending).rejects.toThrow();
    },
  );

  it.each(['hash', 'sessions', 'codes', 'oauth'] as const)(
    'rolls back all state when %s mutation fails',
    (stage) => {
      const repos = createRepositories(db.handle.db);
      const service = new TokensService(repos, db.handle.db);
      const target = service.create({ name: 'rollback-rotation', scope: '*' });
      new SessionsService(repos, Buffer.alloc(32, 1)).create(target.token.id);
      const oauth = new OAuthService(repos, { accessTtlMs: 60000, refreshTtlMs: 120000 });
      const client = oauth.registerClient({ redirectUris: ['https://example.com/cb'] });
      const issue = () =>
        oauth.issueCode({
          clientId: client.clientId,
          redirectUri: 'https://example.com/cb',
          codeChallenge: 'challenge',
          scope: 'mcp',
          subject: target.token.id,
        });
      oauth.redeemCode({
        code: issue(),
        clientId: client.clientId,
        redirectUri: 'https://example.com/cb',
      });
      issue();
      const snapshot = () =>
        ['tokens', 'dashboard_sessions', 'oauth_authorization_codes', 'oauth_tokens'].map((table) =>
          db.handle.raw.prepare(`SELECT * FROM ${table}`).all(),
        );
      const before = snapshot();
      const trigger =
        stage === 'hash'
          ? 'UPDATE OF hash ON tokens'
          : stage === 'sessions'
            ? 'DELETE ON dashboard_sessions'
            : stage === 'codes'
              ? 'UPDATE ON oauth_authorization_codes'
              : 'UPDATE ON oauth_tokens';
      db.handle.raw.exec(
        `CREATE TRIGGER fail_rotation BEFORE ${trigger} BEGIN SELECT RAISE(ABORT, 'rotation failed'); END`,
      );
      expect(() => service.rotate(target.token.id)).toThrow('rotation failed');
      expect(snapshot()).toEqual(before);
    },
  );

  it('does not mint descendants if rotation wins the refresh compare-and-set', () => {
    const repos = createRepositories(db.handle.db);
    const service = new TokensService(repos, db.handle.db);
    const target = service.create({ name: 'refresh-race', scope: '*' });
    const oauth = new OAuthService(repos, { accessTtlMs: 60000, refreshTtlMs: 120000 });
    const client = oauth.registerClient({ redirectUris: ['https://example.com/cb'] });
    const code = oauth.issueCode({
      clientId: client.clientId,
      redirectUri: 'https://example.com/cb',
      codeChallenge: 'challenge',
      scope: 'mcp',
      subject: target.token.id,
    });
    const pair = oauth.redeemCode({
      code,
      clientId: client.clientId,
      redirectUri: 'https://example.com/cb',
    });
    const mark = repos.oauth.markRefreshRotated.bind(repos.oauth);
    vi.spyOn(repos.oauth, 'markRefreshRotated').mockImplementationOnce((id, now) => {
      service.rotate(target.token.id);
      return mark(id, now);
    });
    const insert = vi.spyOn(repos.oauth, 'insertToken');
    expect(() =>
      oauth.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId }),
    ).toThrow();
    expect(insert).not.toHaveBeenCalled();
    expect(oauth.authenticateAccessToken(pair.accessToken)).toBeNull();
  });

  it.each(['cold', 'warm'])(
    'refuses independently deleted rows on %s authentication',
    async (mode) => {
      const target = tokens.create({ name: 'deleted-only', scope: '*' });
      if (mode === 'warm') await tokens.authenticate(target.plaintext);
      db.handle.raw.prepare('UPDATE tokens SET deleted_at = 1 WHERE id = ?').run(target.token.id);
      await expect(tokens.authenticate(target.plaintext)).rejects.toThrow();
    },
  );

  it('refuses a failed conditional hash update', () => {
    const target = tokens.create({ name: 'skip-rotation', scope: '*' });
    db.handle.raw.exec(
      'CREATE TRIGGER skip_rotation BEFORE UPDATE OF hash ON tokens BEGIN SELECT RAISE(IGNORE); END',
    );
    expect(() => tokens.rotate(target.token.id)).toThrow();
    expect(tokens.findById(target.token.id)).toEqual(target.token);
  });

  it.each(['missing', 'hash', 'deleted', 'revoked', 'expired', 'at-now', 'live', 'no-expiry'])(
    'repository hash replacement checks %s independently',
    (kind) => {
      const repo = createRepositories(db.handle.db).tokens;
      const now = new Date(10000);
      const target = tokens.create({
        name: 'conditional-rotate',
        scope: '*',
        expiresAt:
          kind === 'no-expiry'
            ? null
            : new Date(kind === 'expired' ? 9999 : kind === 'at-now' ? 10000 : 10001),
      });
      if (kind === 'revoked') tokens.revoke(target.token.name);
      if (kind === 'deleted')
        db.handle.raw.prepare('UPDATE tokens SET deleted_at = 1 WHERE id = ?').run(target.token.id);
      const before = tokens.findById(target.token.id);
      const live = kind === 'live' || kind === 'no-expiry';
      expect(
        repo.replaceHash(
          kind === 'missing' ? 'missing' : target.token.id,
          kind === 'hash' ? 'wrong' : target.token.hash,
          'replacement',
          now,
        ),
      ).toBe(live ? 1 : 0);
      expect(tokens.findById(target.token.id)).toEqual(
        live ? { ...before, hash: 'replacement' } : before,
      );
    },
  );
});

describe('TokensService.create', () => {
  it('returns the plaintext exactly once and never persists it', () => {
    const { plaintext, token } = tokens.create({ name: 't1', scope: '*' });
    expect(plaintext.length).toBeGreaterThan(20);
    expect(token.hash).not.toContain(plaintext);
    expect(token.name).toBe('t1');
  });

  it('rejects empty names', () => {
    expect(() => tokens.create({ name: '   ', scope: '*' })).toThrow(/non-empty/);
  });

  it('rejects duplicate names', () => {
    tokens.create({ name: 'dup', scope: '*' });
    expect(() => tokens.create({ name: 'dup', scope: '*' })).toThrow(/already exists/);
  });

  it('does not admit a project scope string as caller-supplied input', () => {
    const rejected: CreateTokenInput[] = [
      // @ts-expect-error `project:<id>` must be composed from a resolved project row, never accepted here
      { name: 'slug-write', scope: 'project:alpha' },
      // @ts-expect-error same for the read arm, `read:project:<id>`
      { name: 'slug-read', scope: 'read:project:alpha' },
      // @ts-expect-error the set arm takes resolved project ROWS; a bare slug would re-admit the same defect
      { name: 'slug-set', projects: ['alpha'], access: 'write' },
      // @ts-expect-error and it is non-empty: a credential over no project would authorize nothing at all
      { name: 'empty-set', projects: [], access: 'write' },
    ];
    expect(rejected).toHaveLength(4);
  });
});

describe('TokensService.authenticate', () => {
  it('matches the token via constant-time hash compare', async () => {
    const { plaintext, token } = tokens.create({ name: 't', scope: '*' });
    const resolved = await tokens.authenticate(plaintext);
    expect(resolved.token.id).toBe(token.id);
  });

  it('rejects an unknown token', async () => {
    await expect(tokens.authenticate('not-a-real-token')).rejects.toThrow(/not recognized/);
  });

  it('rejects a revoked token', async () => {
    const { plaintext } = tokens.create({ name: 't', scope: '*' });
    tokens.revoke('t');
    await expect(tokens.authenticate(plaintext)).rejects.toThrow(/revoked/);
  });

  it('rejects an expired token', async () => {
    const past = new Date(Date.now() - 1000);
    const { plaintext } = tokens.create({ name: 't', scope: '*', expiresAt: past });
    await expect(tokens.authenticate(plaintext)).rejects.toThrow(/expired/);
  });
});

describe('TokensService.bootstrapAdmin', () => {
  it('seeds the admin token on first run', () => {
    expect(tokens.count()).toBe(0);
    tokens.bootstrapAdmin('a-strong-admin-token-1234567890');
    expect(tokens.count()).toBe(1);
    const found = tokens.findByName('admin');
    expect(found?.scope).toBe('*');
  });

  it('is idempotent across restarts (ignores env after first run)', () => {
    tokens.bootstrapAdmin('first-admin-token-1234567890');
    const firstHash = tokens.findByName('admin')?.hash;
    tokens.bootstrapAdmin('second-admin-token-1234567890');
    const secondHash = tokens.findByName('admin')?.hash;
    expect(secondHash).toBe(firstHash);
  });

  it('refuses to bootstrap without an admin token on first run', () => {
    expect(() => tokens.bootstrapAdmin(null)).toThrow(/MEMORIA_ADMIN_TOKEN|REMBRIC_ADMIN_TOKEN/i);
  });
});

/** The reach of every token shape that predates `token_projects`: no members. */
const unbound = (scope: TokenScope): TokenReach => ({ scope, memberProjectIds: [] });

describe('isAuthorized', () => {
  it('admin can do anything', () => {
    expect(isAuthorized(unbound('*'), 'write', { scope: 'global' })).toBe(true);
    expect(isAuthorized(unbound('*'), 'read', { scope: 'project', projectId: 'p' })).toBe(true);
  });

  it('read:* allows reads but rejects writes', () => {
    expect(isAuthorized(unbound('read:*'), 'read', { scope: 'global' })).toBe(true);
    expect(isAuthorized(unbound('read:*'), 'write', { scope: 'global' })).toBe(false);
  });

  it('project:<id> restricts to that project', () => {
    expect(
      isAuthorized(unbound('project:abc'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(true);
    expect(
      isAuthorized(unbound('project:abc'), 'write', { scope: 'project', projectId: 'xyz' }),
    ).toBe(false);
    expect(isAuthorized(unbound('project:abc'), 'write', { scope: 'global' })).toBe(false);
    expect(isAuthorized(unbound('project:abc'), 'read', { scope: 'global' })).toBe(false);
    expect(isAuthorized(unbound('read:project:abc'), 'read', { scope: 'global' })).toBe(false);
  });

  it('read:project:<id> only allows reads of that project', () => {
    expect(
      isAuthorized(unbound('read:project:abc'), 'read', { scope: 'project', projectId: 'abc' }),
    ).toBe(true);
    expect(
      isAuthorized(unbound('read:project:abc'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(false);
  });

  it('the two set literals authorize nothing by string alone', () => {
    expect('projects'.startsWith('project:')).toBe(false);
    expect('read:projects'.startsWith('read:project:')).toBe(false);
    for (const scope of ['projects', 'read:projects'] as const) {
      for (const action of ['read', 'write'] as const) {
        for (const target of [
          { scope: 'global' } as const,
          { scope: 'project', projectId: 'abc' } as const,
          { scope: 'project', projectId: null } as const,
        ]) {
          expect(isAuthorized(unbound(scope), action, target), `${scope}/${action}`).toBe(false);
        }
      }
    }
  });

  it('membership adds reach to the set arms, and to nothing else', () => {
    const set = (scope: TokenScope): TokenReach => ({ scope, memberProjectIds: ['abc', 'def'] });
    expect(isAuthorized(set('projects'), 'write', { scope: 'project', projectId: 'abc' })).toBe(
      true,
    );
    expect(isAuthorized(set('projects'), 'read', { scope: 'project', projectId: 'def' })).toBe(
      true,
    );
    expect(isAuthorized(set('projects'), 'write', { scope: 'project', projectId: 'xyz' })).toBe(
      false,
    );
    expect(isAuthorized(set('projects'), 'write', { scope: 'global' })).toBe(false);

    // The verb is not widened by membership.
    expect(isAuthorized(set('read:projects'), 'read', { scope: 'project', projectId: 'abc' })).toBe(
      true,
    );
    expect(
      isAuthorized(set('read:projects'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(false);

    expect(isAuthorized(set('read:*'), 'write', { scope: 'project', projectId: 'abc' })).toBe(
      false,
    );
    expect(isAuthorized(set('project:abc'), 'write', { scope: 'project', projectId: 'def' })).toBe(
      false,
    );
  });

  it('the set arms are pinned to no project', () => {
    expect(pinnedProjectId('projects')).toBeNull();
    expect(pinnedProjectId('read:projects')).toBeNull();
  });
});

describe('TokensService.authenticate — verified-credential cache (#266)', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(db.handle.db);
  });

  it('skips the scrypt scan on a repeat authenticate() call for the same token', async () => {
    const scopedTokens = new TokensService(repos, db.handle.db);
    const { plaintext } = scopedTokens.create({ name: 'cached', scope: '*' });
    const listAllSpy = vi.spyOn(repos.tokens, 'listAll');

    await scopedTokens.authenticate(plaintext);
    expect(listAllSpy).toHaveBeenCalledTimes(1); // cold: full scrypt-verify scan

    await scopedTokens.authenticate(plaintext);
    expect(listAllSpy).toHaveBeenCalledTimes(1); // warm: cache hit, no re-scan
  });

  it('revocation takes effect on the very next request despite a warm cache', async () => {
    const { plaintext } = tokens.create({ name: 'revoke-me', scope: '*' });
    await tokens.authenticate(plaintext); // warm the cache

    tokens.revoke('revoke-me');

    await expect(tokens.authenticate(plaintext)).rejects.toMatchObject({ code: 'token_revoked' });
  });

  it('expiry takes effect on the very next request despite a warm cache', async () => {
    let nowMs = 1_000;
    const clockedTokens = new TokensService(repos, db.handle.db, () => new Date(nowMs));
    const { plaintext } = clockedTokens.create({
      name: 'expiring',
      scope: '*',
      expiresAt: new Date(nowMs + 500),
    });
    await clockedTokens.authenticate(plaintext); // warm the cache, before expiry

    nowMs += 1_000; // advance past expiresAt

    await expect(clockedTokens.authenticate(plaintext)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('a cache hit still resolves the correct token id and scope', async () => {
    const { plaintext, token } = tokens.create({ name: 'resolve-me', scope: 'read:*' });
    await tokens.authenticate(plaintext); // cold
    const resolved = await tokens.authenticate(plaintext); // warm
    expect(resolved.token.id).toBe(token.id);
    expect(resolved.scope).toBe('read:*');
  });

  it('evicts the oldest entry once the cache exceeds its bound', async () => {
    const smallCacheTokens = new TokensService(repos, db.handle.db, undefined, 2);
    const p1 = smallCacheTokens.create({ name: 'evict-1', scope: '*' }).plaintext;
    const p2 = smallCacheTokens.create({ name: 'evict-2', scope: '*' }).plaintext;
    const p3 = smallCacheTokens.create({ name: 'evict-3', scope: '*' }).plaintext;

    await smallCacheTokens.authenticate(p1);
    await smallCacheTokens.authenticate(p2);
    await smallCacheTokens.authenticate(p3); // pushes the cache past its bound of 2, evicting p1

    const listAllSpy = vi.spyOn(repos.tokens, 'listAll');
    await smallCacheTokens.authenticate(p1); // evicted — falls through to the slow path
    expect(listAllSpy).toHaveBeenCalledTimes(1);

    listAllSpy.mockClear();
    await smallCacheTokens.authenticate(p3); // still warm
    expect(listAllSpy).not.toHaveBeenCalled();
  });
});
