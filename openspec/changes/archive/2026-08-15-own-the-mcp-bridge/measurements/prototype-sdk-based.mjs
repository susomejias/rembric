// Prototype gate for @rembric/mcp-proxy — NOT the implementation.
// Raw message pipe: StdioServerTransport (host side) ⇄ StreamableHTTPClientTransport
// (Rembric side). The host's initialize flows through VERBATIM (clientInfo
// passthrough), and a 404 on a session-carrying request triggers one
// re-initialize + retry of the original message.
import { createRequire } from 'node:module';

const require = createRequire('/root/rembric/apps/server/package.json');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const base = process.env.REMBRIC_SERVER_URL;
const token = process.env.REMBRIC_API_TOKEN;
const mcpPath = process.env.RBR_MCP_PATH || '/mcp';
if (!base || !token) {
  process.stderr.write('[proto] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN\n');
  process.exit(1);
}
const url = new URL(base.replace(/\/+$/, '') + mcpPath);

const REINIT_ID = '__rbr_reinit__';
const stdio = new StdioServerTransport();

let stashedInit = null;

function makeHttp() {
  const t = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  t.onmessage = (msg) => {
    if (msg && msg.id === REINIT_ID) {
      process.stderr.write('[proto] swallowed replayed-initialize response\n');
      return;
    }
    void stdio.send(msg);
  };
  t.onerror = (e) => process.stderr.write(`[proto] http onerror: ${e?.message ?? e}\n`);
  return t;
}

let http = makeHttp();
await http.start();

async function sendWithRecovery(msg) {
  try {
    await http.send(msg);
  } catch (e) {
    const status = e instanceof StreamableHTTPError ? e.code : (e?.code ?? e?.status);
    if (status === 404 && stashedInit && msg?.method !== 'initialize') {
      process.stderr.write('[proto] got 404 with a session id -> re-initialize + retry\n');
      try {
        await http.close();
      } catch {}
      http = makeHttp();
      await http.start();
      await http.send({ ...stashedInit, id: REINIT_ID });
      await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await http.send(msg);
      return;
    }
    process.stderr.write(`[proto] send failed (${status ?? 'no-status'}): ${e?.message}\n`);
    throw e;
  }
}

let chain = Promise.resolve();
stdio.onmessage = (msg) => {
  if (msg?.method === 'initialize') stashedInit = msg;
  chain = chain.then(
    () => sendWithRecovery(msg),
    () => sendWithRecovery(msg),
  );
};
stdio.onerror = (e) => process.stderr.write(`[proto] stdio onerror: ${e?.message ?? e}\n`);

await stdio.start();
process.stderr.write(`[proto] up. url=${url.href}\n`);
