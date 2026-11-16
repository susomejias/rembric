// Usage: node latency.mjs <origin> <token> <calls> <warmup>
import { performance } from 'node:perf_hooks';
const [origin, token, callsArg, warmArg] = process.argv.slice(2);
const calls = Number(callsArg),
  warmup = Number(warmArg);
const base = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
let session = null;
async function post(body) {
  const headers = {
    ...base,
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
  };
  const res = await fetch(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return { res, text };
}
const init = await post({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'latency', version: '0' },
  },
});
session = init.res.headers.get('mcp-session-id');
await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
const tools = { 'memory.search': { query: 'wire diff' }, 'project.current': {} };
const out = {};
let id = 1;
for (const [name, args] of Object.entries(tools)) {
  const call = () =>
    post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
  for (let i = 0; i < warmup; i++) await call();
  const samples = [];
  for (let i = 0; i < calls; i++) {
    const t0 = performance.now();
    const { text } = await call();
    samples.push(performance.now() - t0);
    if (text.includes('"isError":true')) throw new Error(`${name} errored: ${text.slice(0, 200)}`);
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  out[name] = {
    n: samples.length,
    p50: q(0.5).toFixed(2),
    p90: q(0.9).toFixed(2),
    min: samples[0].toFixed(2),
    max: samples.at(-1).toFixed(2),
  };
}
console.log(JSON.stringify({ origin, session: session !== null, ...out }));
