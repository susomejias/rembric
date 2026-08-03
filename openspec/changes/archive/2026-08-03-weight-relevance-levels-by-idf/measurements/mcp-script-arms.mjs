/**
 * Task 10.1.2 — the end-to-end symptom, through the real MCP tool.
 *
 * Per script arm: 20 memories that all carry one common word, exactly ONE of
 * which also carries a rare word; the query is `<common> <rare>`. The relative
 * filter (`RELATIVE_LEVEL_RATIO`, shipped 0.4) then decides how many of the 20
 * come back, and the answer is a direct function of the weights the level
 * function gave the two query terms.
 *
 * Run (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/weight-relevance-levels-by-idf/measurements/mcp-script-arms.mjs
 *
 * Instruments, named:
 *   - the MCP tool, over HTTP JSON-RPC (Streamable HTTP), not the handler: the
 *     zod schema and the transport are in the path.
 *   - `FakeEmbedder` (hash-derived unit vectors), so the dense arm contributes
 *     ~0 and the count isolates the LEXICAL component. With a real embedder the
 *     post-amendment non-Latin arms are decided by a meaningful cosine instead
 *     of by noise; that is the point of the fallback, but it is not what this
 *     probe measures.
 *   - one fresh data dir per arm, so the index holds that arm's 20 rows only and
 *     `N = 20` for every arm.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../../../apps/server/src/server/index.js';
import { indexTerms, termWeight } from '../../../../apps/server/src/services/hybrid-search.js';
import { FakeEmbedder } from '../../../../apps/server/src/test/embedder.js';

const ROWS_PER_ARM = 20;
const ADMIN_TOKEN = 'script-arms-admin-token-with-enough-entropy-zz';

/** `common` is in all 20 rows, `rare` in exactly one. Filler keeps the rows distinct. */
const ARMS = [
  {
    name: 'Spanish (control)',
    common: 'migración',
    rare: 'ejecución',
    filler: (i) => `nota ${i} sobre la programación del cron`,
  },
  {
    name: 'German (control)',
    common: 'grüße',
    rare: 'bäckerei',
    filler: (i) => `notiz ${i} über die straße`,
  },
  {
    name: 'Cyrillic without й/ё (control)',
    common: 'проверка',
    rare: 'база',
    filler: (i) => `запись ${i} о сервере`,
  },
  {
    name: 'Cyrillic with й/ё',
    common: 'майский',
    rare: 'ёлка',
    filler: (i) => `запись ${i} о районе`,
  },
  {
    name: 'Greek',
    common: 'αναζήτηση',
    rare: 'ολοκληρώθηκε',
    filler: (i) => `σημείωση ${i} για τον διακομιστή`,
  },
  {
    name: 'Vietnamese',
    common: 'nhớ',
    rare: 'đệm',
    filler: (i) => `ghi chú ${i} về máy chủ`,
  },
  {
    name: 'Devanagari',
    common: 'जाँच',
    rare: 'कैश',
    filler: (i) => `टिप्पणी ${i} सर्वर के बारे में`,
  },
  {
    name: 'Arabic',
    common: 'المؤقت',
    rare: 'ذاكرة',
    filler: (i) => `ملاحظة ${i} عن الخادم`,
  },
  {
    name: 'Japanese',
    common: 'バンド設定',
    rare: 'デバッグ',
    filler: (i) => `メモ ${i} サーバー`,
  },
  {
    name: 'stacked-diacritic Latin',
    common: 'ǻrsrapport',
    rare: 'nguyễn',
    filler: (i) => `anteckning ${i} om servern`,
  },
];

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}

/** Minimal Streamable-HTTP JSON-RPC client: no SDK, so the artifact has no bare imports. */
class McpHttp {
  constructor(baseUrl) {
    this.url = `${baseUrl}/mcp`;
    this.sessionId = undefined;
    this.nextId = 1;
  }

  async post(body, expectResponse = true) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!expectResponse) return undefined;
    const text = await res.text();
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .pop();
    const payload = JSON.parse(line ?? text);
    if (payload.error) throw new Error(`${body.method}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async initialize() {
    await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'script-arms-probe', version: '0.0.0' },
      },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  }

  async call(name, args) {
    return this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }
}

function structured(result) {
  const text = (result.content ?? []).find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function runArm(arm) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-arm-'));
  const port = await findFreePort();
  const server = await createServer(
    {
      REMBRIC_HOST: '127.0.0.1',
      REMBRIC_PORT: String(port),
      REMBRIC_DATA_DIR: dataDir,
      REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      REMBRIC_LOG_LEVEL: 'error',
    },
    { embedder: new FakeEmbedder() },
  );
  try {
    const mcp = new McpHttp(`http://127.0.0.1:${port}`);
    await mcp.initialize();

    for (let i = 0; i < ROWS_PER_ARM; i++) {
      const extra = i === 0 ? ` ${arm.rare}` : '';
      await mcp.call('memory.save', {
        scope: 'global',
        type: 'reference',
        title: `${arm.common} ${i}`,
        content: `${arm.common} ${arm.filler(i)}${extra}`,
      });
    }

    const query = `${arm.common} ${arm.rare}`;
    const found = structured(await mcp.call('memory.search', { query, limit: ROWS_PER_ARM }));
    const returned = (found.results ?? found.memories ?? []).length;

    const raw = server.dbHandle.raw;
    const n = raw.prepare('SELECT count(*) AS n FROM memory').get().n;
    const dfOf = (term) =>
      raw.prepare('SELECT doc FROM memory_fts_vocab WHERE term = ?').get(term)?.doc;
    const appCommon = indexTerms(arm.common)[0];
    const appRare = indexTerms(arm.rare)[0];
    const commonest = raw
      .prepare('SELECT term, doc FROM memory_fts_vocab ORDER BY doc DESC, term LIMIT 1')
      .get();

    return {
      arm: arm.name,
      returned,
      abstained: found.abstained,
      n,
      appCommon,
      dfAppCommon: dfOf(appCommon),
      appRare,
      dfAppRare: dfOf(appRare),
      indexCommonest: `${commonest.term}=${commonest.doc}`,
      weightAppCommon: termWeight(n, dfOf(appCommon) ?? 0),
      weightMax: termWeight(n, 0),
      weightHeld: termWeight(n, ROWS_PER_ARM),
    };
  } finally {
    await server.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const pad = (s, w) => String(s).padEnd(w);
const num = (x, d = 4) => (x === undefined ? '—' : x.toFixed(d));

const rows = [];
for (const arm of ARMS) rows.push(await runArm(arm));

console.log(`rows per arm: ${ROWS_PER_ARM}   query: "<common> <rare>"   limit: ${ROWS_PER_ARM}`);
console.log('the rare word is in exactly ONE of the 20 rows, so a correctly-weighted level');
console.log('returns 1; returning 20 means the two terms were weighted the same.\n');
console.log(
  pad('arm', 30),
  pad('ret/20', 7),
  pad('N', 3),
  pad("app term for 'common'", 22),
  pad('df', 4),
  pad('index commonest', 18),
  pad('w(common)', 10),
  pad('w(absent)', 10),
  pad('w(df=20)', 9),
);
for (const r of rows) {
  console.log(
    pad(r.arm, 30),
    pad(`${r.returned}/${ROWS_PER_ARM}`, 7),
    pad(r.n, 3),
    pad(r.appCommon, 22),
    pad(r.dfAppCommon ?? '—', 4),
    pad(r.indexCommonest, 18),
    pad(num(r.weightAppCommon), 10),
    pad(num(r.weightMax), 10),
    pad(num(r.weightHeld), 9),
  );
}
console.log('\ndf `—` means the index holds no such term: the app tokenised the query into a term');
console.log('the index never produced, so it receives w(absent) — the MAXIMUM weight.');
