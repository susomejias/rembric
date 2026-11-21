import { ancestorChain, HOST_SESSION_HEADER, lookupHostSession } from './rembric-host-binding.mjs';
import { buildEndpoint, FINGERPRINT_HEADER, resolveProject } from './rembric-project.mjs';
import { projectDirectorySource, resolveProjectDirectory } from './slug.mjs';

const MIN_SERVER_VERSION = '0.24.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const TRANSPORT_ERROR_CODE = -32000;

function semver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function olderThan(value, minimum) {
  const actual = semver(value);
  const expected = semver(minimum);
  if (!actual || !expected) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== expected[index]) return actual[index] < expected[index];
  }
  return false;
}

function messageKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function jsonMessage(raw) {
  try {
    const message = JSON.parse(raw);
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}

function hasId(message) {
  return Boolean(message && Object.hasOwn(message, 'id'));
}

function emit(stream, payload) {
  stream.write(`${payload}\n`);
}

function correlatedError(id, message) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: TRANSPORT_ERROR_CODE, message },
  });
}

function describeFailure(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runBridge({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = env.REMBRIC_SERVER_URL;
  const token = env.REMBRIC_API_TOKEN;
  if (!baseUrl || !token) {
    const missing = [!baseUrl && 'REMBRIC_SERVER_URL', !token && 'REMBRIC_API_TOKEN']
      .filter(Boolean)
      .join(' and ');
    stderr.write(`[rembric-bridge] Missing ${missing}. Configure the plugin.\n`);
    return 1;
  }

  const projectDir = resolveProjectDirectory(env);
  const project = await resolveProject({
    startDir: projectDir,
    env,
    serverUrl: baseUrl,
    apiToken: token,
    fetchImpl,
  });
  const issuePrefix = project.issue ? `${project.issue}; ` : '';
  if (project.mode === 'refused') {
    stderr.write(`[rembric-bridge] ${issuePrefix}${project.message}\n`);
    return 1;
  }
  if (project.mode === 'unbound') {
    stderr.write(`[rembric-bridge] ${issuePrefix}${project.message}\n`);
  } else if (project.issue) {
    stderr.write(
      project.slug
        ? `[rembric-bridge] ${project.issue}; using slug ${project.slug}.\n`
        : `[rembric-bridge] ${project.issue}; add a .rembric file containing PROJECT_SLUG=<slug> ` +
            `to ${projectDir} or set REMBRIC_PROJECT_SLUG. Using path-less /mcp, which resolves to ` +
            `the server's default project.\n`,
    );
  }
  if (project.conflict) stderr.write(`[rembric-bridge] ${project.message}\n`);
  const endpoint = buildEndpoint(baseUrl, project.mode === 'project' ? project.slug : null);
  stderr.write(
    `[rembric-bridge] projectDir=${projectDir} (from ${projectDirectorySource(env)}) url=${endpoint}\n`,
  );

  const healthUrl = `${baseUrl.replace(/\/+$/, '')}/healthz`;
  void fetchImpl(healthUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2000),
  })
    .then(async (response) => {
      if (!response.ok) return;
      const body = await response.json();
      if (body?.version && olderThan(body.version, MIN_SERVER_VERSION)) {
        stderr.write(
          `[rembric-bridge] server version ${body.version} is older than this plugin expects ` +
            `(${MIN_SERVER_VERSION}+); update via the dashboard or see docs/updates.md.\n`,
        );
      }
    })
    .catch(() => {});

  const ancestors = ancestorChain();
  let sessionId = null;
  let negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;
  let initializationReady = Promise.resolve();
  const active = new Set();
  const controllers = new Set();
  let terminated = false;
  let finish;

  function requestHeaders(isInitialize) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': negotiatedProtocolVersion,
    };
    if (sessionId && !isInitialize) headers['mcp-session-id'] = sessionId;
    if (project.header) headers[FINGERPRINT_HEADER] = project.header;
    const declaredSession = lookupHostSession(ancestors);
    if (declaredSession) headers[HOST_SESSION_HEADER] = declaredSession;
    return headers;
  }

  async function post(raw, isInitialize) {
    const controller = new globalThis.AbortController();
    controllers.add(controller);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: requestHeaders(isInitialize),
        body: raw,
        signal: controller.signal,
      });
      if (isInitialize) sessionId = response.headers.get('mcp-session-id');
      return { response, controller };
    } catch (error) {
      controllers.delete(controller);
      throw error;
    }
  }

  function updateNegotiatedVersion(message) {
    if (
      message?.result &&
      typeof message.result === 'object' &&
      typeof message.result.protocolVersion === 'string'
    ) {
      negotiatedProtocolVersion = message.result.protocolVersion;
    }
  }

  async function consume(response, { expectedId, controller, initialize = false } = {}) {
    const expectedKey = expectedId === undefined ? null : messageKey(expectedId);
    let responded = expectedKey === null;
    let sawRpcMessage = false;
    const contentType = response.headers.get('content-type') ?? '';
    const handle = (payload) => {
      const message = jsonMessage(payload);
      if (!message) return false;
      sawRpcMessage = true;
      if (expectedKey !== null && hasId(message) && messageKey(message.id) === expectedKey) {
        responded = true;
        if (initialize) updateNegotiatedVersion(message);
        emit(stdout, payload);
        return true;
      }
      return false;
    };

    try {
      if (!response.body || !contentType.includes('text/event-stream')) {
        const body = await response.text();
        if (body.trim()) {
          if (!handle(body.trim()) && !response.ok && !sawRpcMessage) {
            throw new Error(`HTTP ${response.status} returned a non-JSON-RPC response`);
          }
        } else if (expectedKey !== null || !response.ok) {
          throw new Error(`HTTP ${response.status} returned no JSON-RPC response`);
        }
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const flush = (final = false) => {
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = final ? '' : (parts.pop() ?? '');
          for (const event of parts) {
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n');
            if (data) handle(data);
          }
        };

        while (true) {
          let read;
          try {
            read = await reader.read();
          } catch {
            throw new Error('SSE response disconnected before the JSON-RPC response');
          }
          buffer += decoder.decode(read.value, { stream: !read.done });
          flush(read.done);
          if (read.done) break;
        }
        if (expectedKey !== null && !responded) {
          throw new Error('SSE response disconnected before the JSON-RPC response');
        }
        if (!response.ok && !sawRpcMessage) {
          throw new Error(`HTTP ${response.status} returned a non-JSON-RPC response`);
        }
      }
      if (expectedKey !== null && !responded) {
        throw new Error(`HTTP ${response.status} returned no correlated JSON-RPC response`);
      }
    } finally {
      controllers.delete(controller);
    }
  }

  function failHostRequest(message, error, status) {
    if (hasId(message)) {
      emit(stdout, correlatedError(message.id, status ? `${error} (HTTP ${status})` : error));
      return;
    }
    terminate(`transport failure: ${error}${status ? ` (HTTP ${status})` : ''}`);
  }

  function terminate(reason) {
    if (terminated) return;
    terminated = true;
    stderr.write(`[rembric-bridge] ${reason}\n`);
    for (const controller of controllers) controller.abort();
    stdin.destroy();
    finish?.(1);
  }

  async function sendHostRequest(raw) {
    const message = jsonMessage(raw);
    if (!message) return;
    const isInitialize = message.method === 'initialize';

    try {
      const posted = await post(raw, isInitialize);
      await consume(posted.response, {
        expectedId: hasId(message) ? message.id : undefined,
        controller: posted.controller,
        initialize: isInitialize,
      });
    } catch (error) {
      const failure = describeFailure(error);
      const status = /HTTP (\d+)/.exec(failure)?.[1];
      failHostRequest(message, failure, status ? Number(status) : undefined);
    }
  }

  return new Promise((resolve) => {
    finish = (code) => resolve(code);
    let buffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      if (terminated) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) void handleLine(line);
    });
    stdin.on('end', async () => {
      if (terminated) return;
      if (buffer) await handleLine(buffer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(active);
      finish?.(0);
    });

    async function handleLine(line) {
      if (terminated || !line.trim()) return;
      const raw = line;
      const message = jsonMessage(raw);
      if (!message) return;

      let operation;
      if (message.method === 'initialize') {
        operation = sendHostRequest(raw);
        initializationReady = operation.catch(() => {});
      } else {
        operation = initializationReady.then(() => sendHostRequest(raw));
      }
      active.add(operation);
      await operation;
      active.delete(operation);
    }
  });
}
