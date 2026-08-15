// Zero-dependency prototype gate for @rembric/mcp-bridge.
// stdio (host side) <-> Streamable HTTP (Rembric side), no SDK, no deps.
//
// The point of this prototype is ONE question: can a hand-rolled proxy relay a
// server-initiated request (roots/list) that arrives on a tool call's SSE
// stream, and post the host's response back? Everything else here exists only
// to reach that question.
import { createInterface } from 'node:readline';

const base = process.env.REMBRIC_SERVER_URL;
const token = process.env.REMBRIC_API_TOKEN;
const mcpPath = process.env.RBR_MCP_PATH || '/mcp';
if (!base || !token) {
  process.stderr.write('[proto0] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN\n');
  process.exit(1);
}
const url = base.replace(/\/+$/, '') + mcpPath;

let sessionId = null;
let stashedInit = null;

function log(s) {
  process.stderr.write(`[proto0] ${s}\n`);
}

function toHost(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function headers() {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

/** Reads an SSE body, emitting each `data:` JSON payload to the host. */
async function pumpSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }
      // A server-initiated REQUEST (has method AND id) is the arm under test:
      // hand it to the host and let its answer come back through stdin.
      if (msg.method && msg.id !== undefined) {
        log(`server-initiated request on stream: ${msg.method} id=${msg.id} -> host`);
      }
      toHost(msg);
    }
  }
}

async function post(msg) {
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(msg) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (res.status === 404 && stashedInit && msg.method !== 'initialize') {
    log('404 on a session-carrying request -> re-initialize + retry');
    await res.text().catch(() => {});
    sessionId = null;
    await post(stashedInit);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return post(msg);
  }
  if (res.status === 202) return; // notification / response accepted
  if (!res.ok) {
    log(`HTTP ${res.status} for ${msg.method ?? 'response'}`);
    await res.text().catch(() => {});
    return;
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) return pumpSse(res);
  const body = await res.json().catch(() => null);
  if (body) {
    // The replayed initialize after a 404 is ours, not the host's.
    if (stashedInit && body.id === stashedInit.id && msg === stashedInit && sessionId) {
      log('swallowed replayed-initialize response');
      return;
    }
    toHost(body);
  }
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.method === 'initialize') stashedInit = msg;
  // Responses from the host (roots/list answers) have no `method` — they post
  // back on the same endpoint, which is what closes the bidirectional loop.
  if (!msg.method && msg.id !== undefined) log(`host response id=${msg.id} -> server`);
  chain = chain.then(
    () => post(msg),
    () => post(msg),
  );
});

log(`up. url=${url}`);
