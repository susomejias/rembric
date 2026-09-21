import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreatedToken } from '@rembric/core';
import type { Project } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as fallbackGet, POST as fallbackPost } from '../app/api/[...path]/route';
import { GET as countersGet, POST as countersPost } from '../app/api/[slug]/debug/counters/route';
import { POST as recallPost } from '../app/api/[slug]/memory/recall/route';
import { POST as endPost } from '../app/api/[slug]/sessions/[id]/end/route';
import { POST as hintsPost } from '../app/api/[slug]/sessions/[id]/recall-hints/route';
import { POST as resumePost } from '../app/api/[slug]/sessions/[id]/resume/route';
import { POST as summaryPost } from '../app/api/[slug]/sessions/[id]/summary/route';
import { POST as turnPost } from '../app/api/[slug]/sessions/[id]/turn/route';
import { POST as sessionsPost, GET as sessionsGet } from '../app/api/[slug]/sessions/route';
import { getServices } from '../lib/services';

/**
 * The `/api/[slug]` session-lifecycle surface — the App Router counterpart of
 * `apps/server`'s Hono `api-router.ts`. This drives the REAL route handlers over
 * a real migrated database: the auth pipeline, validation, service calls,
 * status codes and `{ ok: false, code }` bodies are all the production path.
 *
 * Two things are deliberately outside this suite:
 *   - a successful `POST /memory/recall`, because `lib/services.ts` wires the
 *     real embedder as the query embedder and `memory.search` calls it
 *     unconditionally (a model load, not a database read). The refusal paths
 *     have no embedder in them and are covered.
 *   - the `sweep`/`forcedSweep` background work, which is fire-and-forget by
 *     contract and unobservable from a response.
 */

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {
    // ignore double-close of a fixture the process already closed
  }
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
}

const ORIGIN = 'http://127.0.0.1:8787';

let dataDir: string;
let admin: CreatedToken;
let project: Project;
let otherProject: Project;
let writer: CreatedToken;
let writerB: CreatedToken;
let reader: CreatedToken;

beforeEach(() => {
  resetAppGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-api-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  // The OAuth fallback is present iff REMBRIC_PUBLIC_URL is set; unset keeps
  // every case on the static-token path this suite is about.
  delete process.env['REMBRIC_PUBLIC_URL'];

  const services = getServices();
  admin = services.tokens.create({ name: 'api-admin', scope: '*' });
  project = services.projects.create({ slug: 'api-proj' });
  otherProject = services.projects.create({ slug: 'other-proj' });
  writer = services.tokens.create({ name: 'api-writer', project, access: 'write' });
  writerB = services.tokens.create({ name: 'api-writer-b', project, access: 'write' });
  reader = services.tokens.create({ name: 'api-reader', project, access: 'read' });
});

afterEach(async () => {
  // The session-start consolidation sweep is fire-and-forget (`services.sweep`
  // schedules on `setImmediate`), so let it run while the connection is still
  // open instead of logging a spurious "connection is not open" after cleanup.
  await new Promise((resolve) => setImmediate(resolve));
  resetAppGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  rmSync(dataDir, { recursive: true, force: true });
});

function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function body(res: Response | Promise<Response>): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const response = await res;
  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

/** Call a route handler with the segment params Next would supply. */
function call<P extends Record<string, string>>(
  handler: (request: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  req: Request,
  params: P,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return body(handler(req, { params: Promise.resolve(params) }));
}

const slugCtx = (): { slug: string } => ({ slug: project.slug });
const sessionCtx = (id: string): { slug: string; id: string } => ({ slug: project.slug, id });

describe('auth and project scope', () => {
  it('401 missing_token when the Authorization header is absent', async () => {
    const r = await call(sessionsPost, request('POST', `/api/${project.slug}/sessions`), slugCtx());
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ ok: false, code: 'missing_token' });
  });

  it('401 token_invalid on an unknown bearer', async () => {
    const r = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: 'not-a-real-token',
        body: { id: 'sess-a1b2c3d4' },
      }),
      slugCtx(),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ ok: false, code: 'token_invalid' });
  });

  it('404 project_not_found naming the slug the caller used, never another project', async () => {
    const r = await call(
      sessionsPost,
      request('POST', '/api/no-such-slug/sessions', {
        token: admin.plaintext,
        body: { id: 'sess-a1b2c3d4' },
      }),
      { slug: 'no-such-slug' },
    );
    expect(r.status).toBe(404);
    expect(r.json).toEqual({
      ok: false,
      code: 'project_not_found',
      slug: 'no-such-slug',
    });
  });

  it('403 forbidden when a project-scoped token addresses another project', async () => {
    const r = await call(
      sessionsPost,
      request('POST', `/api/${otherProject.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'sess-a1b2c3d4' },
      }),
      { slug: otherProject.slug },
    );
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('403 forbidden when a read-only token attempts a write', async () => {
    const r = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: reader.plaintext,
        body: { id: 'sess-a1b2c3d4' },
      }),
      slugCtx(),
    );
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('method → handler mapping', () => {
  it("answers the not_found body, not Next's 405, for an undeclared method on a declared path", async () => {
    const r = await body(sessionsGet(request('GET', `/api/${project.slug}/sessions`)));
    expect(r.status).toBe(404);
    expect(r.json).toEqual({
      ok: false,
      code: 'not_found',
      path: `/api/${project.slug}/sessions`,
    });
  });

  it('answers not_found for an undeclared method on a GET-declared path', async () => {
    const r = await body(countersPost(request('POST', `/api/${project.slug}/debug/counters`)));
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ code: 'not_found' });
    expect(r.json.path).toBe(`/api/${project.slug}/debug/counters`);
  });

  it('does not consult auth for the declared method (control for the 405 replacement)', async () => {
    // The declared POST on the same path IS authenticated, so the 404 above is
    // the fallback answering rather than an auth refusal in disguise.
    const declared = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`),
      slugCtx(),
    );
    expect(declared.status).toBe(401);
    expect(declared.json.code).toBe('missing_token');
  });

  it('the catch-all route answers not_found for an unknown path, without auth', async () => {
    const r = await body(fallbackGet(request('GET', `/api/${project.slug}/no-such-endpoint`)));
    expect(r.status).toBe(404);
    expect(r.json).toEqual({
      ok: false,
      code: 'not_found',
      path: `/api/${project.slug}/no-such-endpoint`,
    });
    const posted = await body(
      fallbackPost(request('POST', `/api/${project.slug}/no-such-endpoint`)),
    );
    expect(posted.status).toBe(404);
    expect(posted.json.code).toBe('not_found');
  });
});

describe('POST /:slug/sessions', () => {
  it('creates a session row and reports created: true', async () => {
    const r = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'sess-create1', cwd: '/tmp/foo', agent: 'claude' },
      }),
      slugCtx(),
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      sessionId: 'sess-create1',
      scope: 'project',
      projectId: project.id,
      created: true,
    });
    expect(typeof r.json.startedAt).toBe('string');
  });

  it('is idempotent: a second POST for the same id reports created: false', async () => {
    const once = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'sess-idem1' },
      }),
      slugCtx(),
    );
    const twice = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'sess-idem1' },
      }),
      slugCtx(),
    );
    expect(once.json.created).toBe(true);
    expect(twice.json.created).toBe(false);
    expect(twice.json.sessionId).toBe(once.json.sessionId);
  });

  it('409 id_collision when another token already owns the id', async () => {
    await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'sess-collide1' },
      }),
      slugCtx(),
    );
    const r = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writerB.plaintext,
        body: { id: 'sess-collide1' },
      }),
      slugCtx(),
    );
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, code: 'id_collision' });
  });

  it('400 invalid_input on a missing or malformed id, and on a non-object body', async () => {
    const missing = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, { token: writer.plaintext, body: {} }),
      slugCtx(),
    );
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe('invalid_input');
    expect(String(missing.json.message)).toContain('id');

    const malformed = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: { id: 'short' },
      }),
      slugCtx(),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.json.code).toBe('invalid_input');

    const notObject = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, {
        token: writer.plaintext,
        body: ['nope'],
      }),
      slugCtx(),
    );
    expect(notObject.status).toBe(400);
    expect(notObject.json.code).toBe('invalid_input');
  });
});

describe('session routes: token binding and lifecycle', () => {
  async function ensure(id: string, token = writer): Promise<void> {
    const r = await call(
      sessionsPost,
      request('POST', `/api/${project.slug}/sessions`, { token: token.plaintext, body: { id } }),
      slugCtx(),
    );
    expect(r.status).toBe(200);
  }

  it('persists a summary without transitioning the session status', async () => {
    await ensure('sess-summary1');
    const r = await call(
      summaryPost,
      request('POST', `/api/${project.slug}/sessions/sess-summary1/summary`, {
        token: writer.plaintext,
        body: { summary: 'a curated summary', title: 'the title' },
      }),
      sessionCtx('sess-summary1'),
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      sessionId: 'sess-summary1',
      summary: 'a curated summary',
      title: 'the title',
    });
    expect(getServices().agentSessions.getById('sess-summary1')?.status).toBe('active');
  });

  it('404 session_not_found — never 403 — when the row belongs to another token', async () => {
    await ensure('sess-foreign1', writer);
    const r = await call(
      summaryPost,
      request('POST', `/api/${project.slug}/sessions/sess-foreign1/summary`, {
        token: writerB.plaintext,
        body: { summary: 'not mine' },
      }),
      sessionCtx('sess-foreign1'),
    );
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, code: 'session_not_found' });
  });

  it('409 session_deleted for a soft-deleted row', async () => {
    await ensure('sess-deleted1');
    getServices().agentSessions.softDelete('sess-deleted1', { tokenId: writer.token.id });
    const r = await call(
      summaryPost,
      request('POST', `/api/${project.slug}/sessions/sess-deleted1/summary`, {
        token: writer.plaintext,
        body: { summary: 'late' },
      }),
      sessionCtx('sess-deleted1'),
    );
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, code: 'session_deleted' });
  });

  it('end closes an active session and reports the ended-at stamp', async () => {
    await ensure('sess-end1');
    const r = await call(
      endPost,
      request('POST', `/api/${project.slug}/sessions/sess-end1/end`, {
        token: writer.plaintext,
        body: { summary: 'closing summary' },
      }),
      sessionCtx('sess-end1'),
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.endedAt).toBe('string');
    expect(getServices().agentSessions.getById('sess-end1')?.status).toBe('ended');
  });

  it('resume returns an ended session to active and reports what it discarded', async () => {
    await ensure('sess-resume1');
    await call(
      endPost,
      request('POST', `/api/${project.slug}/sessions/sess-resume1/end`, {
        token: writer.plaintext,
      }),
      sessionCtx('sess-resume1'),
    );
    const r = await call(
      resumePost,
      request('POST', `/api/${project.slug}/sessions/sess-resume1/resume`, {
        token: writer.plaintext,
      }),
      sessionCtx('sess-resume1'),
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, sessionId: 'sess-resume1', status: 'active' });
    expect(r.json.previousStatus).toBe('ended');
  });

  it('resume refuses an unknown property rather than discarding it with a 200', async () => {
    await ensure('sess-resume2');
    const r = await call(
      resumePost,
      request('POST', `/api/${project.slug}/sessions/sess-resume2/resume`, {
        token: writer.plaintext,
        body: { sumary: 'typo' },
      }),
      sessionCtx('sess-resume2'),
    );
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(String(r.json.message)).toContain('Unrecognized key');
  });

  it('turn answers a work-bearing report with a lines array', async () => {
    await ensure('sess-turn1');
    const r = await call(
      turnPost,
      request('POST', `/api/${project.slug}/sessions/sess-turn1/turn`, {
        token: writer.plaintext,
        body: { usedTools: true },
      }),
      sessionCtx('sess-turn1'),
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(Array.isArray(r.json.lines)).toBe(true);
  });

  it('turn 400 invalid_input when usedTools is missing, and writes no activity', async () => {
    await ensure('sess-turn2');
    const before = getServices().agentSessions.getById('sess-turn2')?.lastActivityAt;
    const r = await call(
      turnPost,
      request('POST', `/api/${project.slug}/sessions/sess-turn2/turn`, {
        token: writer.plaintext,
        body: {},
      }),
      sessionCtx('sess-turn2'),
    );
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('invalid_input');
    expect(String(r.json.message)).toContain('usedTools');
    const after = getServices().agentSessions.getById('sess-turn2')?.lastActivityAt;
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('recall-hints answers an empty prompt with no lines, on a read action', async () => {
    // Seeded through the service with the READ token as owner: `/sessions`
    // itself requires write, and ownership is by token id, so this is the only
    // way to reach a read-only caller that owns its session.
    getServices().agentSessions.ensure({
      id: 'sess-hints1',
      tokenId: reader.token.id,
      projectId: project.id,
      agent: 'claude',
    });
    const r = await call(
      hintsPost,
      request('POST', `/api/${project.slug}/sessions/sess-hints1/recall-hints`, {
        token: reader.plaintext,
        body: { prompt: '' },
      }),
      sessionCtx('sess-hints1'),
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, lines: [] });
  });

  it('a session route on an unknown id is 404 session_not_found', async () => {
    const r = await call(
      summaryPost,
      request('POST', `/api/${project.slug}/sessions/sess-missing1/summary`, {
        token: writer.plaintext,
        body: { summary: 'x' },
      }),
      sessionCtx('sess-missing1'),
    );
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ code: 'session_not_found' });
  });
});

describe('GET /:slug/debug/counters', () => {
  it('returns the counter maps to an admin token', async () => {
    const r = await call(
      countersGet,
      request('GET', `/api/${project.slug}/debug/counters`, { token: admin.plaintext }),
      slugCtx(),
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    expect(r.json.counters).toBeTypeOf('object');
    expect(r.json.recall).toBeTypeOf('object');
  });

  it('403 for a non-admin token, which is refused before anything is read', async () => {
    const r = await call(
      countersGet,
      request('GET', `/api/${project.slug}/debug/counters`, { token: writer.plaintext }),
      slugCtx(),
    );
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('401 for an unauthenticated caller', async () => {
    const r = await call(
      countersGet,
      request('GET', `/api/${project.slug}/debug/counters`),
      slugCtx(),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ ok: false, code: 'missing_token' });
  });
});

describe('POST /:slug/memory/recall — refusals', () => {
  it('400 invalid_input on an empty or missing query, before any search runs', async () => {
    for (const body of [{}, { query: '' }, { query: 'x', limit: 0 }, null]) {
      const r = await call(
        recallPost,
        request('POST', `/api/${project.slug}/memory/recall`, {
          token: reader.plaintext,
          body,
        }),
        slugCtx(),
      );
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
    }
  });

  it('404 project_not_found on an unknown slug', async () => {
    const r = await call(
      recallPost,
      request('POST', '/api/no-such-slug/memory/recall', {
        token: admin.plaintext,
        body: { query: 'anything' },
      }),
      { slug: 'no-such-slug' },
    );
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, code: 'project_not_found' });
  });
});
