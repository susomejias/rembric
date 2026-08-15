import { parseDotenv, SLUG_RE } from './rembric-dotenv.mjs';
import {
  buildEndpoint,
  projectDirectorySource,
  resolveProjectDirectory,
  resolveSlug,
} from './slug.mjs';

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

function isServerRequest(message) {
  return Boolean(message && typeof message.method === 'string' && hasId(message));
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

async function discardBody(response) {
  try {
    await response.arrayBuffer();
  } catch {
    await response.text().catch(() => {});
  }
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
  const slugResult = resolveSlug(projectDir, env, parseDotenv, SLUG_RE);
  if (slugResult.issue) {
    stderr.write(
      `[rembric-bridge] ${slugResult.issue}; using ${slugResult.slug ? `slug ${slugResult.slug}` : 'path-less /mcp'}.\n`,
    );
  }
  const endpoint = buildEndpoint(baseUrl, slugResult.slug);
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

  let sessionId = null;
  let sessionGeneration = 0;
  let negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;
  let latestInitialize = null;
  let recoveryPromise = null;
  let initializationReady = Promise.resolve();
  const pendingServerRequests = new Map();
  const active = new Set();
  const controllers = new Set();
  let terminated = false;
  let finish;

  function requestHeaders(session) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': negotiatedProtocolVersion,
    };
    if (session) headers['mcp-session-id'] = session;
    return headers;
  }

  async function post(raw, includeSession = true) {
    const sentSession = includeSession ? sessionId : null;
    const sentGeneration = sessionGeneration;
    const controller = new globalThis.AbortController();
    controllers.add(controller);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: requestHeaders(sentSession),
        body: raw,
        signal: controller.signal,
      });
      const nextSessionId = response.headers.get('mcp-session-id');
      if (nextSessionId && response.status !== 404 && sentGeneration === sessionGeneration) {
        sessionId = nextSessionId;
      }
      return { response, sentSession, controller };
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

  async function consume(
    response,
    { expectedId, forwardResponses, controller, initialize = false } = {},
  ) {
    const expectedKey = expectedId === undefined ? null : messageKey(expectedId);
    let responded = expectedKey === null;
    let sawRpcMessage = false;
    const contentType = response.headers.get('content-type') ?? '';
    const handle = (payload) => {
      const message = jsonMessage(payload);
      if (!message) return false;
      sawRpcMessage = true;

      if (isServerRequest(message)) {
        pendingServerRequests.set(messageKey(message.id), message.id);
        emit(stdout, payload);
        return false;
      }

      if (expectedKey !== null && hasId(message) && messageKey(message.id) === expectedKey) {
        responded = true;
        if (initialize) updateNegotiatedVersion(message);
        if (forwardResponses) emit(stdout, payload);
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
      return responded;
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

  async function sendServerResponse(raw) {
    try {
      const posted = await post(raw);
      await consume(posted.response, { forwardResponses: false, controller: posted.controller });
    } catch (error) {
      pendingServerRequests.delete(messageKey(jsonMessage(raw)?.id));
      terminate(`server request response failed: ${describeFailure(error)}`);
    }
  }

  async function reinitialize() {
    if (!latestInitialize) throw new Error('Cannot recover before initialize');
    const initializeMessage = jsonMessage(latestInitialize);
    if (!hasId(initializeMessage)) throw new Error('Cannot recover without an initialize id');
    const initialized = await post(latestInitialize, false);
    await consume(initialized.response, {
      expectedId: initializeMessage.id,
      forwardResponses: false,
      controller: initialized.controller,
      initialize: true,
    });

    const notification = await post('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    if (!notification.response.ok && notification.response.status !== 202) {
      await discardBody(notification.response);
      controllers.delete(notification.controller);
      throw new Error(`initialized notification failed with HTTP ${notification.response.status}`);
    }
    await consume(notification.response, {
      forwardResponses: false,
      controller: notification.controller,
    });
  }

  async function recover(failedSession) {
    if (recoveryPromise) {
      await recoveryPromise;
      return;
    }
    if (sessionId !== failedSession) return;
    if (!recoveryPromise) {
      sessionId = null;
      sessionGeneration += 1;
      recoveryPromise = reinitialize().finally(() => {
        recoveryPromise = null;
      });
    }
    await recoveryPromise;
  }

  async function sendHostRequest(raw) {
    const message = jsonMessage(raw);
    if (!message) return;
    const isInitialize = message.method === 'initialize';
    if (isInitialize) latestInitialize = raw;

    try {
      if (!isInitialize && recoveryPromise && message.method !== 'notifications/cancelled') {
        await recoveryPromise;
      }
      const posted = await post(raw, !isInitialize);
      if (posted.response.status === 404 && posted.sentSession) {
        await discardBody(posted.response);
        controllers.delete(posted.controller);
        await recover(posted.sentSession);
        const retry = await post(raw);
        await consume(retry.response, {
          expectedId: hasId(message) ? message.id : undefined,
          forwardResponses: true,
          controller: retry.controller,
        });
        return;
      }
      await consume(posted.response, {
        expectedId: hasId(message) ? message.id : undefined,
        forwardResponses: true,
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
      await Promise.all(active);
      finish?.(0);
    });

    async function handleLine(line) {
      if (terminated || !line.trim()) return;
      const raw = line;
      const message = jsonMessage(raw);
      if (!message) return;

      if (!message.method && hasId(message)) {
        const key = messageKey(message.id);
        if (pendingServerRequests.has(key)) {
          pendingServerRequests.delete(key);
          const operation = sendServerResponse(raw);
          active.add(operation);
          await operation;
          active.delete(operation);
          return;
        }
      }

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
