// Minimal MCP JSON-RPC client over the Streamable HTTP transport.
//
// Speaks just enough of the MCP wire protocol to call `tools/call` against
// Rembric's `/mcp` or `/mcp/<slug>` endpoint. Session state (the
// `mcp-session-id` header returned after `initialize`) is cached on this
// instance and reused across calls; a 404/440-style invalidation triggers
// a single transparent re-initialize.
//
// No dependencies. No SDK. Hand-rolled because the OpenClaw plugin tree
// ships zero deps (the @openclaw/plugin-sdk is workspace:* upstream and
// not installable here).

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'rembric-openclaw', version: '0.7.0' };

export function createMcpClient({ serverUrl, apiToken, slug, logger, timeoutMs = 10_000 }) {
  if (!serverUrl) throw new Error('createMcpClient: serverUrl required');
  if (!apiToken) throw new Error('createMcpClient: apiToken required');

  const base = String(serverUrl).replace(/\/+$/, '');
  const path = slug ? `/mcp/${slug}` : '/mcp';
  const url = `${base}${path}`;

  let sessionId = null;
  let nextRequestId = 1;
  let initInFlight = null;

  async function rawPost(body, { withSession }) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiToken}`,
    };
    if (withSession && sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  }

  function parseRpc(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:') || trimmed.startsWith('event:')) {
      for (const line of trimmed.split(/\r?\n/)) {
        const m = line.match(/^data:\s*(.*)$/);
        if (m && m[1]) {
          try {
            return JSON.parse(m[1]);
          } catch {
            // fall through
          }
        }
      }
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  async function ensureInitialized() {
    if (sessionId) return;
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      const id = nextRequestId++;
      const body = {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      };
      const res = await rawPost(body, { withSession: false });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`mcp initialize failed: ${res.status} ${text}`);
      }
      const sid = res.headers.get('mcp-session-id');
      if (!sid) throw new Error('mcp initialize: server did not return mcp-session-id');
      sessionId = sid;
      // Drain body — server may emit the initialize response in either
      // SSE or JSON shape; we don't need its contents, only the session id.
      try {
        await res.text();
      } catch {
        // best effort
      }
      // Send `notifications/initialized` per MCP spec to complete the
      // handshake. Server expects this before accepting tool calls.
      try {
        await rawPost(
          { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
          { withSession: true },
        );
      } catch (err) {
        logger?.warn?.(`mcp notifications/initialized warning: ${String(err)}`);
      }
    })();
    try {
      await initInFlight;
    } finally {
      initInFlight = null;
    }
  }

  async function callTool(name, args = {}) {
    try {
      await ensureInitialized();
    } catch (err) {
      logger?.warn?.(`mcp init: ${String(err)}`);
      return { ok: false, code: 'mcp_init_failed', message: String(err) };
    }
    const id = nextRequestId++;
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    let res;
    try {
      res = await rawPost(body, { withSession: true });
    } catch (err) {
      const code = err?.name === 'TimeoutError' ? 'timeout' : 'network_error';
      logger?.warn?.(`mcp ${name}: ${String(err)}`);
      return { ok: false, code, message: String(err) };
    }
    if (res.status === 404 || res.status === 440) {
      // Session expired upstream; clear and retry once.
      sessionId = null;
      try {
        await ensureInitialized();
        const retry = await rawPost({ ...body, id: nextRequestId++ }, { withSession: true });
        if (!retry.ok) {
          return { ok: false, code: 'server_error', message: `${retry.status}` };
        }
        const text = await retry.text().catch(() => '');
        const parsed = parseRpc(text);
        if (!parsed) return { ok: false, code: 'parse_error', message: 'empty response' };
        if (parsed.error) {
          return {
            ok: false,
            code: 'mcp_error',
            message: parsed.error?.message || 'mcp error',
          };
        }
        return { ok: true, data: parsed.result };
      } catch (err) {
        return { ok: false, code: 'mcp_init_failed', message: String(err) };
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        code: res.status >= 500 ? 'server_error' : 'http_error',
        message: `${res.status} ${text}`,
      };
    }
    const text = await res.text().catch(() => '');
    const parsed = parseRpc(text);
    if (!parsed) return { ok: false, code: 'parse_error', message: 'empty response' };
    if (parsed.error) {
      return { ok: false, code: 'mcp_error', message: parsed.error?.message || 'mcp error' };
    }
    return { ok: true, data: parsed.result };
  }

  function reset() {
    sessionId = null;
    initInFlight = null;
  }

  return {
    callTool,
    reset,
    get sessionId() {
      return sessionId;
    },
  };
}
