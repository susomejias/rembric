// Minimal Streamable HTTP MCP stub for the 404-recovery experiment.
// Behavior: initialize mints a session; the session DIES right after its
// first successful tools/call; every later request naming that session id
// gets 404/-32001 (the MCP spec's "session terminated" signal). A fresh
// initialize always works, so a spec-conformant client recovers.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = 8923;
const LOG = process.env.STUB_LOG;
const sessions = new Map();
let seq = 0;

function log(line) {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const sid = req.headers['mcp-session-id'] ?? null;
    const method = body?.method ?? `(http ${req.method} ${req.url})`;

    if (req.method === 'GET') {
      log(`GET ${req.url} sid=${sid}`);
      if (String(req.url).includes('.well-known')) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Spec-allowed "no standalone SSE stream offered here".
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      log(`DELETE sid=${sid}`);
      res.writeHead(200);
      res.end();
      return;
    }

    if (body?.method === 'initialize') {
      const id = `s${++seq}`;
      sessions.set(id, { dead: false, toolCalls: 0 });
      const clientName = body.params?.clientInfo?.name ?? '(none)';
      const clientVersion = body.params?.clientInfo?.version ?? '?';
      log(
        `POST initialize (carried sid=${sid}) -> NEW SESSION ${id} clientInfo=${clientName}@${clientVersion}`,
      );
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'evict-stub', version: '0' },
          },
        }),
      );
      return;
    }

    const s = sid ? sessions.get(sid) : undefined;
    if (sid && (!s || s.dead)) {
      log(`POST ${method} sid=${sid} -> 404 (session dead/unknown)`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }),
      );
      return;
    }

    if (!body?.id) {
      log(`POST ${method} sid=${sid} -> 202 (notification)`);
      res.writeHead(202);
      res.end();
      return;
    }

    if (body.method === 'tools/list') {
      log(`POST tools/list sid=${sid} -> 200`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'echo_probe',
                description: 'Returns a probe counter for connection testing.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          },
        }),
      );
      return;
    }

    if (body.method === 'tools/call') {
      s.toolCalls += 1;
      log(`POST tools/call sid=${sid} call#${s.toolCalls} -> 200, session ${sid} NOW DEAD`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: `probe-ok session=${sid} call=${s.toolCalls}` }],
            isError: false,
          },
        }),
      );
      s.dead = true;
      return;
    }

    log(`POST ${method} sid=${sid} -> 200 (empty result)`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
  });
});

server.listen(PORT, '127.0.0.1', () => log(`stub listening on 127.0.0.1:${PORT}`));
