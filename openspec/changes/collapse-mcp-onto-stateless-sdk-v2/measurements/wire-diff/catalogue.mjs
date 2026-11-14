import { createHash } from 'node:crypto';

const LEGACY = '2025-06-18';
const MODERN = '2026-07-28';
const REDIRECT = 'https://client.example/callback';
const VERIFIER = 'wire-diff-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const DEFAULT_BODY_CAP = 4 * 1024 * 1024;

const initializeBody = (protocolVersion = LEGACY) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'wire-diff', version: '0' } },
});

const modernEnvelope = (protocolVersion = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': protocolVersion,
  'io.modelcontextprotocol/clientInfo': { name: 'wire-diff', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

function mcpHeaders(ctx, extra = {}) {
  return {
    authorization: `Bearer ${ctx.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

function sessionHeaders(ctx, sidVar = 'sid') {
  return mcpHeaders(ctx, {
    'mcp-session-id': ctx.vars[sidVar],
    'mcp-protocol-version': LEGACY,
  });
}

function init(name, path = '/mcp', sidVar = 'sid', protocolVersion = LEGACY) {
  return {
    name,
    method: 'POST',
    path,
    headers: (ctx) => mcpHeaders(ctx),
    body: () => initializeBody(protocolVersion),
    capture: { [sidVar]: (r) => r.headers['mcp-session-id'] },
  };
}

function initialized(name, path = '/mcp', sidVar = 'sid') {
  return {
    name,
    method: 'POST',
    path,
    headers: (ctx) => sessionHeaders(ctx, sidVar),
    body: () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  };
}

let nextId = 100;
function rpc(name, method, params, extra = {}) {
  const id = nextId++;
  return {
    name,
    method: 'POST',
    path: extra.path ?? '/mcp',
    headers: (ctx) => sessionHeaders(ctx, extra.sidVar ?? 'sid'),
    body: (ctx) => ({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined
        ? {}
        : { params: typeof params === 'function' ? params(ctx) : params }),
    }),
    capture: extra.capture,
  };
}

function tool(name, toolName, args = {}, extra = {}) {
  return rpc(
    name,
    'tools/call',
    (ctx) => ({ name: toolName, arguments: typeof args === 'function' ? args(ctx) : args }),
    extra,
  );
}

const form = (fields) => new URLSearchParams(fields).toString();
const formHeaders = (extra = {}) => ({
  'content-type': 'application/x-www-form-urlencoded',
  ...extra,
});

function authorizeQuery(ctx, overrides = {}) {
  return new URLSearchParams({
    client_id: ctx.vars.clientId ?? 'oauthc_missing',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'wire-diff-state',
    ...overrides,
  }).toString();
}

const locationParam = (param) => (r) => {
  const location = r.headers['location'];
  if (location === undefined) return undefined;
  return new URL(location, 'http://placeholder.invalid').searchParams.get(param) ?? undefined;
};

function consentFlow(prefix, decision) {
  return [
    {
      name: `${prefix} authorize GET (registered client, S256)`,
      method: 'GET',
      path: (ctx) => `/authorize?${authorizeQuery(ctx)}`,
      capture: { [`${prefix}Areq`]: locationParam('areq') },
    },
    {
      name: `${prefix} consent page GET (dashboard session)`,
      method: 'GET',
      path: (ctx) =>
        `/dashboard/oauth-consent?areq=${encodeURIComponent(ctx.vars[`${prefix}Areq`] ?? '')}`,
      headers: (ctx) => ({ cookie: ctx.vars.cookie ?? '' }),
      compareBody: false,
      capture: {
        [`${prefix}Csrf`]: (r) => /name="csrf" value="([^"]+)"/.exec(r.text)?.[1],
      },
    },
    {
      name: `${prefix} consent POST decision=${decision}`,
      method: 'POST',
      path: '/dashboard/oauth/consent',
      headers: (ctx) => formHeaders({ cookie: ctx.vars.cookie ?? '' }),
      body: (ctx) =>
        form({
          csrf: ctx.vars[`${prefix}Csrf`] ?? '',
          areq: ctx.vars[`${prefix}Areq`] ?? '',
          decision,
        }),
      capture: { [`${prefix}Code`]: locationParam('code') },
    },
  ];
}

const tokenPost = (name, fields) => ({
  name,
  method: 'POST',
  path: '/token',
  headers: () => formHeaders(),
  body: (ctx) => form(typeof fields === 'function' ? fields(ctx) : fields),
});

const toolJson = (path) => (r) => {
  let value = r.toolJson;
  for (const key of path) value = value?.[key];
  return value;
};

const mergeArgs = (ctx) => ({
  ids: [ctx.vars.memoryA, ctx.vars.passiveId].filter(Boolean),
  type: 'reference',
  title: 'Wire diff fixture merged',
  content: 'The wire diff harness replays fixed request shapes and masks volatile identifiers.',
  tags: ['wire-diff'],
});

export const catalogue = [
  init('initialize 2025-06-18 path-less /mcp'),
  initialized('notifications/initialized'),
  rpc('tools/list', 'tools/list', {}),
  rpc('ping', 'ping'),
  rpc('unknown JSON-RPC method', 'no/such_method', {}),
  init('initialize 2025-03-26 path-less /mcp', '/mcp', 'sidOld', '2025-03-26'),
  rpc('tools/list on a 2025-03-26 session', 'tools/list', {}, { sidVar: 'sidOld' }),

  tool(
    'tools/call project.current',
    'project.current',
    {},
    {
      capture: { defaultSlug: toolJson(['slug']) },
    },
  ),
  tool('tools/call project.list', 'project.list', {}),
  tool('tools/call memory.about', 'memory.about', {}),
  tool('tools/call memory.stats', 'memory.stats', {}),
  tool('tools/call memory.doctor', 'memory.doctor', {}),
  tool(
    'tools/call memory.session_start',
    'memory.session_start',
    {
      agent: 'wire-diff',
      description: 'wire diff session',
    },
    { capture: { rembricSession: toolJson(['sessionId']) } },
  ),
  tool(
    'tools/call memory.save',
    'memory.save',
    (ctx) => ({
      type: 'reference',
      title: 'Wire diff fixture alpha',
      content: 'The wire diff harness replays fixed request shapes against two servers.',
      tags: ['wire-diff'],
      sessionId: ctx.vars.rembricSession,
    }),
    { capture: { memoryA: toolJson(['id']) } },
  ),
  tool(
    'tools/call memory.save (topic_key, no sessionId)',
    'memory.save',
    {
      type: 'project',
      title: 'Wire diff fixture beta',
      content: 'The wire diff harness masks volatile identifiers per server.',
      tags: ['wire-diff', 'normalization'],
      topic_key: 'wire-diff/beta',
    },
    { capture: { memoryB: toolJson(['id']) } },
  ),
  tool('tools/call memory.save (validation error: no tags)', 'memory.save', {
    type: 'reference',
    title: 'Missing tags',
    content: 'This save must be refused by the input schema.',
  }),
  tool('tools/call memory.search', 'memory.search', { query: 'wire diff harness' }),
  tool('tools/call memory.context', 'memory.context', {}),
  tool('tools/call memory.get_batch', 'memory.get_batch', (ctx) => ({
    ids: [ctx.vars.memoryA, ctx.vars.memoryB].filter(Boolean),
  })),
  tool('tools/call memory.timeline', 'memory.timeline', (ctx) => ({ memoryId: ctx.vars.memoryA })),
  tool('tools/call memory.confirm_batch', 'memory.confirm_batch', (ctx) => ({
    ids: [ctx.vars.memoryA].filter(Boolean),
  })),
  tool('tools/call memory.compare', 'memory.compare', (ctx) => ({
    memoryIdA: ctx.vars.memoryA,
    memoryIdB: ctx.vars.memoryB,
    relation: 'related',
    confidence: 0.5,
  })),
  tool('tools/call memory.judge_batch (unknown judgment)', 'memory.judge_batch', {
    judgments: [{ judgmentId: 'no-such-judgment', relation: 'related' }],
  }),
  tool('tools/call memory.suggest_topic_key', 'memory.suggest_topic_key', {
    type: 'reference',
    title: 'Wire diff harness',
  }),
  tool('tools/call memory.save_prompt', 'memory.save_prompt', {
    title: 'Wire diff prompt',
    content: 'Replay the catalogue against both servers.',
  }),
  tool('tools/call memory.search_prompts', 'memory.search_prompts', { query: 'catalogue' }),
  tool(
    'tools/call memory.capture_passive',
    'memory.capture_passive',
    {
      text: '## Key Learnings\n1. The wire diff harness masks volatile identifiers per server.',
      tags: ['wire-diff'],
    },
    { capture: { passiveId: toolJson(['ids', 0]) } },
  ),
  tool('tools/call memory.merge (preview)', 'memory.merge', (ctx) => mergeArgs(ctx), {
    capture: { fingerprint: toolJson(['fingerprint']) },
  }),
  tool('tools/call memory.merge (with fingerprint)', 'memory.merge', (ctx) => ({
    ...mergeArgs(ctx),
    fingerprint: ctx.vars.fingerprint,
  })),
  tool('tools/call memory.archive', 'memory.archive', (ctx) => ({ id: ctx.vars.memoryB })),
  tool('tools/call memory.session_summary', 'memory.session_summary', (ctx) => ({
    sessionId: ctx.vars.rembricSession,
    title: 'Wire diff summary',
    summary: '## Goal\nReplay the catalogue.',
  })),
  tool('tools/call memory.session_get_batch', 'memory.session_get_batch', (ctx) => ({
    ids: [ctx.vars.rembricSession].filter(Boolean),
  })),
  tool('tools/call memory.session_end', 'memory.session_end', (ctx) => ({
    sessionId: ctx.vars.rembricSession,
  })),
  tool('tools/call memory.session_resume', 'memory.session_resume', (ctx) => ({
    sessionId: ctx.vars.rembricSession,
  })),
  tool('tools/call memory.session_end (after resume)', 'memory.session_end', (ctx) => ({
    sessionId: ctx.vars.rembricSession,
  })),
  tool(
    'tools/call memory.session_start({project}) default slug',
    'memory.session_start',
    (ctx) => ({
      agent: 'wire-diff',
      project: ctx.vars.defaultSlug,
    }),
    { capture: { rembricSession2: toolJson(['sessionId']) } },
  ),
  tool('tools/call project.use while a session is active', 'project.use', (ctx) => ({
    slug: ctx.vars.defaultSlug,
  })),
  tool('tools/call memory.session_end (project session)', 'memory.session_end', (ctx) => ({
    sessionId: ctx.vars.rembricSession2,
  })),
  tool('tools/call project.use (unknown slug, no autocreate)', 'project.use', {
    slug: 'wire-diff-missing',
  }),
  tool('tools/call project.use (default slug)', 'project.use', (ctx) => ({
    slug: ctx.vars.defaultSlug,
    confirmSwitch: true,
  })),
  tool('tools/call unknown tool', 'no.such_tool', {}),

  {
    name: 'GET standalone SSE stream (keepalive window)',
    method: 'GET',
    path: '/mcp',
    headers: (ctx) => ({
      authorization: `Bearer ${ctx.token}`,
      accept: 'text/event-stream',
      'mcp-session-id': ctx.vars.sid,
      'mcp-protocol-version': LEGACY,
    }),
    stream: true,
  },
  {
    name: 'GET /mcp without a session id',
    method: 'GET',
    path: '/mcp',
    headers: (ctx) => ({ authorization: `Bearer ${ctx.token}`, accept: 'text/event-stream' }),
    stream: true,
  },
  {
    name: 'DELETE /mcp with the session id',
    method: 'DELETE',
    path: '/mcp',
    headers: (ctx) => sessionHeaders(ctx),
  },
  rpc('tools/list with the deleted session id', 'tools/list', {}),
  {
    name: 'DELETE /mcp without a session id',
    method: 'DELETE',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx),
  },
  {
    name: 'tools/list with an unknown mcp-session-id',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { 'mcp-session-id': 'no-such-session-id' }),
    body: () => ({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  },
  {
    name: 'tools/list with no session id and no initialize',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { 'mcp-protocol-version': LEGACY }),
    body: () => ({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  },

  init('initialize /mcp/<default slug>', (ctx) => `/mcp/${ctx.vars.defaultSlug}`, 'sidSlug'),
  tool(
    'tools/call project.current on /mcp/<default slug>',
    'project.current',
    {},
    {
      path: (ctx) => `/mcp/${ctx.vars.defaultSlug}`,
      sidVar: 'sidSlug',
    },
  ),
  tool(
    'tools/call project.use on /mcp/<default slug> (locked)',
    'project.use',
    {
      slug: 'wire-diff-other',
    },
    { path: (ctx) => `/mcp/${ctx.vars.defaultSlug}`, sidVar: 'sidSlug' },
  ),
  init('initialize /mcp/<unknown slug>', '/mcp/wire-diff-unknown-project', 'sidUnknown'),
  tool(
    'tools/call project.current on /mcp/<unknown slug>',
    'project.current',
    {},
    {
      path: '/mcp/wire-diff-unknown-project',
      sidVar: 'sidUnknown',
    },
  ),
  {
    name: 'initialize /mcp/<invalid slug>',
    method: 'POST',
    path: '/mcp/bad%20slug!',
    headers: (ctx) => mcpHeaders(ctx),
    body: () => initializeBody(),
  },

  {
    name: 'initialize with no bearer',
    method: 'POST',
    path: '/mcp',
    headers: () => ({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with an invalid bearer',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { authorization: 'Bearer not-a-real-token-value' }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with a non-Bearer Authorization scheme',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) =>
      mcpHeaders(ctx, { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with Accept: application/json only',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { accept: 'application/json' }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with Content-Type: text/plain',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { 'content-type': 'text/plain' }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with a malformed JSON body',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx),
    body: () => '{"jsonrpc":"2.0","id":1,',
  },
  {
    name: 'JSON-RPC batch (initialize + tools/list)',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx),
    body: () => [initializeBody(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
  },
  {
    name: 'initialize with a body over the default 4 MiB cap',
    method: 'POST',
    earlyResponse: true,
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx),
    body: () => ({ ...initializeBody(), pad: 'x'.repeat(DEFAULT_BODY_CAP) }),
  },
  {
    name: 'initialize with a disallowed Origin',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { origin: 'https://evil.example' }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with the allowed Origin (control)',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { origin: ctx.origin }),
    body: () => initializeBody(),
  },
  {
    name: 'initialize with a disallowed Host',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { host: 'rebind.example:80' }),
    body: () => initializeBody(),
  },

  {
    name: '2026-07-28 server/discover',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) =>
      mcpHeaders(ctx, { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' }),
    body: () => ({
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
      params: { _meta: modernEnvelope() },
    }),
  },
  {
    name: '2026-07-28 tools/list with envelope',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) =>
      mcpHeaders(ctx, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }),
    body: () => ({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
      params: { _meta: modernEnvelope() },
    }),
  },
  {
    name: '2026-07-28 notifications/cancelled',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) =>
      mcpHeaders(ctx, { 'mcp-protocol-version': MODERN, 'mcp-method': 'notifications/cancelled' }),
    body: () => ({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { _meta: modernEnvelope() },
    }),
  },
  {
    name: '2026-07-28 header without envelope (malformed)',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { 'mcp-protocol-version': MODERN }),
    body: () => ({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  },
  {
    name: 'envelope claiming 2025-06-18',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx),
    body: () => ({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
      params: { _meta: modernEnvelope(LEGACY) },
    }),
  },

  {
    name: 'GET /.well-known/oauth-authorization-server',
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
  },
  {
    name: 'GET /.well-known/oauth-protected-resource',
    method: 'GET',
    path: '/.well-known/oauth-protected-resource',
  },
  {
    name: 'GET /.well-known/oauth-protected-resource/mcp',
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp',
  },
  {
    name: 'POST /register (valid public client)',
    method: 'POST',
    path: '/register',
    headers: () => ({ 'content-type': 'application/json' }),
    body: () => ({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'wire-diff',
    }),
    capture: { clientId: (r) => r.json?.client_id },
  },
  {
    name: 'POST /register (invalid metadata: no redirect_uris)',
    method: 'POST',
    path: '/register',
    headers: () => ({ 'content-type': 'application/json' }),
    body: () => ({ client_name: 'wire-diff' }),
  },
  {
    name: 'GET /authorize (unregistered client)',
    method: 'GET',
    path: (ctx) => `/authorize?${authorizeQuery(ctx, { client_id: 'oauthc_not-registered' })}`,
  },
  {
    name: 'GET /authorize (plain PKCE method)',
    method: 'GET',
    path: (ctx) => `/authorize?${authorizeQuery(ctx, { code_challenge_method: 'plain' })}`,
  },
  {
    name: 'OPTIONS /token (CORS preflight)',
    method: 'OPTIONS',
    path: '/token',
    headers: () => ({ origin: 'https://client.example', 'access-control-request-method': 'POST' }),
  },
  { name: 'GET /token (405)', method: 'GET', path: '/token' },
  tokenPost('POST /token (unregistered client)', {
    grant_type: 'authorization_code',
    code: 'not-a-code',
    code_verifier: 'verifier',
    redirect_uri: REDIRECT,
    client_id: 'oauthc_not-registered',
  }),
  tokenPost('POST /token (registered client, unknown code)', (ctx) => ({
    grant_type: 'authorization_code',
    code: 'not-a-code',
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: ctx.vars.clientId ?? '',
  })),
  tokenPost('POST /token (unsupported grant_type)', (ctx) => ({
    grant_type: 'password',
    client_id: ctx.vars.clientId ?? '',
  })),
  {
    name: 'POST /revoke (unknown token)',
    method: 'POST',
    path: '/revoke',
    headers: () => formHeaders(),
    body: (ctx) => form({ token: 'not-a-token', client_id: ctx.vars.clientId ?? '' }),
  },
  {
    name: 'POST /dashboard/login (admin token)',
    method: 'POST',
    path: '/dashboard/login',
    headers: () => formHeaders(),
    body: (ctx) => form({ token: ctx.token }),
    capture: { cookie: (r) => [r.headers['set-cookie'] ?? []].flat()[0]?.split(';')[0] },
  },
  ...consentFlow('grant', 'approve'),
  tokenPost('POST /token (authorization_code, wrong verifier)', (ctx) => ({
    grant_type: 'authorization_code',
    code: ctx.vars.grantCode ?? '',
    code_verifier: `${VERIFIER}-wrong`,
    redirect_uri: REDIRECT,
    client_id: ctx.vars.clientId ?? '',
  })),
  ...consentFlow('second', 'approve'),
  {
    ...tokenPost('POST /token (authorization_code, valid)', (ctx) => ({
      grant_type: 'authorization_code',
      code: ctx.vars.secondCode ?? '',
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: ctx.vars.clientId ?? '',
    })),
    capture: { access: (r) => r.json?.access_token, refresh: (r) => r.json?.refresh_token },
  },
  tokenPost('POST /token (authorization_code, reused code)', (ctx) => ({
    grant_type: 'authorization_code',
    code: ctx.vars.secondCode ?? '',
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: ctx.vars.clientId ?? '',
  })),
  {
    name: 'initialize with the OAuth access token',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { authorization: `Bearer ${ctx.vars.access ?? ''}` }),
    body: () => initializeBody(),
  },
  {
    ...tokenPost('POST /token (refresh_token rotation)', (ctx) => ({
      grant_type: 'refresh_token',
      refresh_token: ctx.vars.refresh ?? '',
      client_id: ctx.vars.clientId ?? '',
    })),
    capture: { access2: (r) => r.json?.access_token },
  },
  tokenPost('POST /token (refresh_token reuse)', (ctx) => ({
    grant_type: 'refresh_token',
    refresh_token: ctx.vars.refresh ?? '',
    client_id: ctx.vars.clientId ?? '',
  })),
  {
    name: 'initialize with the rotated access token after reuse detection',
    method: 'POST',
    path: '/mcp',
    headers: (ctx) => mcpHeaders(ctx, { authorization: `Bearer ${ctx.vars.access2 ?? ''}` }),
    body: () => initializeBody(),
  },
  ...consentFlow('denied', 'deny'),
  {
    name: 'POST /revoke (owner, access token)',
    method: 'POST',
    path: '/revoke',
    headers: () => formHeaders(),
    body: (ctx) => form({ token: ctx.vars.access2 ?? '', client_id: ctx.vars.clientId ?? '' }),
  },
];
