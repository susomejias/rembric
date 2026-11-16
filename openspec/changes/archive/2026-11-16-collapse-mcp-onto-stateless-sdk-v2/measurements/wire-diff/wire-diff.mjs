#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { parseArgs } from 'node:util';

import { catalogue } from './catalogue.mjs';

const IGNORED_HEADERS = new Set([
  'date',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'etag',
]);
const VOLATILE_HEADERS = new Set(['ratelimit-reset', 'retry-after']);
const VOLATILE_NUMBER_KEY = /(At|_at|Ms|_ms|duration|elapsed|uptime|latency|took|issued|iat|exp)$/;

const USAGE =
  'usage: node wire-diff.mjs --base <url> --candidate <url> --token <admin-bearer> [--out <file>] [--dump <file>] [--stream-ms <n>] [--timeout-ms <n>]';

class HarnessError extends Error {}

function parseCli() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      candidate: { type: 'string' },
      token: { type: 'string' },
      out: { type: 'string' },
      dump: { type: 'string' },
      'stream-ms': { type: 'string', default: '16000' },
      'timeout-ms': { type: 'string', default: '60000' },
    },
  });
  if (!values.base || !values.candidate || !values.token) throw new HarnessError(USAGE);
  return {
    base: new URL(values.base),
    candidate: new URL(values.candidate),
    token: values.token,
    out: values.out,
    dump: values.dump,
    streamMs: Number(values['stream-ms']),
    timeoutMs: Number(values['timeout-ms']),
  };
}

function send(server, step, ctx, opts) {
  const resolve = (v) => (typeof v === 'function' ? v(ctx) : v);
  const path = resolve(step.path);
  const headers = Object.fromEntries(
    Object.entries(resolve(step.headers) ?? {}).filter(([, v]) => v !== undefined && v !== null),
  );
  const rawBody = step.body === undefined ? undefined : step.body(ctx);
  const body =
    rawBody === undefined || typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

  const requestFn = server.protocol === 'https:' ? httpsRequest : httpRequest;
  if (step.earlyResponse) return sendRaw(server, step, path, headers, body, opts);
  return new Promise((done, fail) => {
    const req = requestFn(
      {
        protocol: server.protocol,
        hostname: server.hostname,
        port: server.port,
        method: step.method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        let settled = false;
        const finish = (truncated) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        };
        const windowMs = step.stream ? opts.streamMs : opts.timeoutMs;
        const timer = setTimeout(() => {
          if (!step.stream) {
            res.destroy();
            fail(new HarnessError(`${step.name}: response not complete after ${windowMs}ms`));
            return;
          }
          finish(true);
          res.destroy();
        }, windowMs);
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(false));
        res.on('error', (err) => {
          if (!settled) fail(new HarnessError(`${step.name}: ${err.message}`));
        });
      },
    );
    req.on('error', (err) => fail(new HarnessError(`${step.name}: ${err.message}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sendRaw(server, step, path, headers, body, opts) {
  const head = [
    `${step.method} ${path} HTTP/1.1`,
    `host: ${headers.host ?? server.host}`,
    'connection: close',
    ...Object.entries(headers)
      .filter(([k]) => k !== 'host')
      .map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n');
  const connect = server.protocol === 'https:' ? tlsConnect : netConnect;
  const port = Number(server.port || (server.protocol === 'https:' ? 443 : 80));
  return new Promise((done, fail) => {
    const chunks = [];
    const socket = connect({ host: server.hostname, port, servername: server.hostname }, () => {
      socket.write(head);
      if (body !== undefined) socket.end(body);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new HarnessError(`${step.name}: response not complete after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        clearTimeout(timer);
        fail(new HarnessError(`${step.name}: ${err.message}`));
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      const split = bytes.indexOf('\r\n\r\n');
      const raw = bytes.subarray(0, Math.max(split, 0)).toString('latin1');
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
      if (split < 0 || status === null) {
        fail(new HarnessError(`${step.name}: connection closed before a complete response head`));
        return;
      }
      const responseHeaders = {};
      for (const line of raw.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        responseHeaders[key] = key in responseHeaders ? `${responseHeaders[key]}, ${value}` : value;
      }
      let payload = bytes.subarray(split + 4);
      if (/chunked/i.test(responseHeaders['transfer-encoding'] ?? '')) payload = dechunk(payload);
      done({
        status: Number(status[1]),
        headers: responseHeaders,
        text: payload.toString('utf8'),
        truncated: false,
      });
    });
  });
}

function dechunk(payload) {
  const parts = [];
  let rest = payload;
  for (;;) {
    const eol = rest.indexOf('\r\n');
    const size = eol < 0 ? 0 : parseInt(rest.subarray(0, eol).toString('latin1'), 16);
    if (!(size > 0)) return Buffer.concat(parts);
    parts.push(rest.subarray(eol + 2, eol + 2 + size));
    rest = rest.subarray(eol + 2 + size + 2);
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue;
    const event = {};
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) event.comment = line.slice(1).trim();
      else {
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else event[field] = value;
      }
    }
    if (data.length > 0) {
      const joined = data.join('\n');
      event.data = tryJson(joined) ?? joined;
    }
    events.push(event);
  }
  return events;
}

function expandToolText(message) {
  const content = message?.result?.content;
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      content: content.map((c) => {
        const parsed = c?.type === 'text' ? tryJson(c.text) : undefined;
        return parsed === undefined ? c : { ...c, text: parsed };
      }),
    },
  };
}

function interpret(raw, step) {
  const contentType = String(raw.headers['content-type'] ?? '');
  let body;
  let message;
  if (step.compareBody === false) {
    body = `<omitted: ${contentType || 'no content-type'}>`;
  } else if (contentType.includes('text/event-stream')) {
    body = {
      sse: parseSse(raw.text).map((e) =>
        'data' in e ? { ...e, data: expandToolText(e.data) } : e,
      ),
    };
    if (raw.truncated) body.streamWindowClosed = true;
    message = body.sse.find((e) => typeof e.data === 'object')?.data;
  } else if (raw.text === '') {
    body = '<empty>';
  } else {
    const json = tryJson(raw.text);
    body = json === undefined ? raw.text : expandToolText(json);
    message = json;
  }
  const json = tryJson(raw.text);
  const firstText = message?.result?.content?.[0]?.text;
  const toolJson = typeof firstText === 'string' ? tryJson(firstText) : firstText;
  return {
    response: {
      status: raw.status,
      headers: raw.headers,
      text: raw.text,
      json,
      toolJson,
    },
    record: {
      status: raw.status,
      headers: Object.fromEntries(
        Object.entries(raw.headers)
          .filter(([k]) => !IGNORED_HEADERS.has(k))
          .map(([k, v]) => [
            k,
            VOLATILE_HEADERS.has(k) ? '<volatile>' : Array.isArray(v) ? v.join('\n') : v,
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      body,
    },
  };
}

class Masker {
  constructor(server) {
    this.host = server.host;
    this.origin = server.origin;
    this.ids = new Map();
  }

  label(kind, value) {
    let byKind = this.ids.get(kind);
    if (byKind === undefined) this.ids.set(kind, (byKind = new Map()));
    if (!byKind.has(value)) byKind.set(value, byKind.size + 1);
    return `<${kind}:${byKind.get(value)}>`;
  }

  string(s) {
    return s
      .split(this.origin)
      .join('<origin>')
      .split(this.host)
      .join('<host>')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/g, '<http-date>')
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, (m) => this.label('ulid', m))
      .replace(/\b[0-9a-f]{64}\b/g, (m) => this.label('sha256', m))
      .replace(/\b(?=[0-9a-z]*[0-9])(?=[0-9a-z]*[a-z])[0-9a-z]{26}\b/g, (m) => this.label('id', m))
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) =>
        this.label('uuid', m.toLowerCase()),
      )
      .replace(/\boauth[a-z]*_[A-Za-z0-9_-]+/g, (m) => this.label(m.split('_')[0], m))
      .replace(/[A-Za-z0-9_\-.~+/]{32,}={0,2}/g, (m) =>
        /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) ? '<opaque>' : m,
      )
      .replace(/\b\d{2}:\d{2}(:\d{2})? UTC\b/g, '<clock> UTC')
      .replace(/\b\d+(\.\d+)?\s?ms\b/g, '<n>ms');
  }

  value(v, key = '') {
    if (typeof v === 'string') return this.string(v);
    if (typeof v === 'number') return VOLATILE_NUMBER_KEY.test(key) ? '<num>' : v;
    if (Array.isArray(v)) return v.map((x) => this.value(x, key));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.value(x, k)]));
    }
    return v;
  }
}

async function replay(server, token, opts) {
  const ctx = { token, vars: {}, origin: server.origin, host: server.host };
  const masker = new Masker(server);
  const records = [];
  for (const step of catalogue) {
    const raw = await send(server, step, ctx, opts);
    const { response, record } = interpret(raw, step);
    for (const [name, pick] of Object.entries(step.capture ?? {})) {
      ctx.vars[name] = pick(response) ?? undefined;
    }
    records.push(masker.value(record));
  }
  return records;
}

function flatten(value, prefix, out) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    if (entries.length === 0) out.set(prefix, Array.isArray(value) ? '[]' : '{}');
    for (const [k, v] of entries) flatten(v, prefix === '' ? k : `${prefix}.${k}`, out);
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

function diffRecord(a, b) {
  const fa = flatten(a, '', new Map());
  const fb = flatten(b, '', new Map());
  const keys = [...new Set([...fa.keys(), ...fb.keys()])];
  const lines = [];
  for (const k of keys) {
    const va = fa.get(k);
    const vb = fb.get(k);
    if (va === vb) continue;
    lines.push(`- ${k}: ${va ?? '(absent)'}`, `+ ${k}: ${vb ?? '(absent)'}`);
  }
  return lines;
}

async function main() {
  const opts = parseCli();
  const started = Date.now();
  const [base, candidate] = await Promise.all([
    replay(opts.base, opts.token, opts),
    replay(opts.candidate, opts.token, opts),
  ]);
  const summary = [];
  const details = [];
  let differences = 0;
  catalogue.forEach((step, i) => {
    const n = String(i + 1).padStart(3, '0');
    const lines = diffRecord(base[i], candidate[i]);
    summary.push(`${lines.length === 0 ? 'same' : 'DIFF'}  ${n}  ${step.name}`);
    if (lines.length > 0) {
      differences += 1;
      details.push(
        '',
        `--- ${n}  ${step.name}  (- base ${opts.base.origin}, + candidate ${opts.candidate.origin})`,
        ...lines,
      );
    }
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const report = [
    ...summary,
    ...details,
    '',
    `${catalogue.length} request shapes, ${differences} with differences, ${seconds}s`,
    '',
  ].join('\n');
  process.stdout.write(report);
  if (opts.out) writeFileSync(opts.out, report);
  if (opts.dump) {
    const dump = catalogue.map((step, i) => ({
      name: step.name,
      base: base[i],
      candidate: candidate[i],
    }));
    writeFileSync(opts.dump, `${JSON.stringify(dump, null, 2)}\n`);
  }
  return differences === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `wire-diff: ${err instanceof HarnessError ? err.message : (err?.stack ?? err)}\n`,
    );
    process.exit(2);
  },
);
