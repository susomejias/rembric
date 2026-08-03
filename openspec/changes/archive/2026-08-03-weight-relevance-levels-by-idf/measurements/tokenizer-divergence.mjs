/**
 * Task 10.1.1 — how far the application's tokenisation (`indexTerms`) diverges
 * from the terms FTS5 actually stores, per script.
 *
 * Run (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/weight-relevance-levels-by-idf/measurements/tokenizer-divergence.mjs
 *
 * Instrument: one document per sample in an FTS5 table whose declaration is
 * DERIVED from the migrated `memory_fts` (`inheritedFts5Arguments`), so the
 * tokenizer is the shipped one rather than a restated `fts5(body)`; the index's
 * terms are read back through `fts5vocab(…,'instance')`.
 *
 * Spanish, German and Cyrillic-without-й/ё are the CONTROLS and must measure 0%:
 * with only failing arms a broken probe is indistinguishable from a real
 * divergence. This measures `indexTerms`, which the amendment does NOT change —
 * the row side keeps it deliberately (design.md D3b) — so the numbers are the
 * same before and after.
 */
import { inheritedFts5Arguments } from '../../../../apps/server/src/db/query-tokenizer.js';
import { indexTerms } from '../../../../apps/server/src/services/hybrid-search.js';
import { createTestDb } from '../../../../apps/server/src/test/index.js';

const SAMPLES = [
  { name: 'Spanish (CONTROL)', text: 'Migración de cron programada; validación ejecución' },
  { name: 'German (CONTROL)', text: 'Grüße Straße Bäckerei Fuß' },
  { name: 'Cyrillic without й/ё (CONTROL)', text: 'проверка база сервер' },
  { name: 'Cyrillic with й/ё', text: 'Майский район войти ёлка' },
  { name: 'Greek', text: 'Η αναζήτηση ολοκληρώθηκε επιτυχώς ΤΕΛΟΣ τέλος' },
  { name: 'Vietnamese', text: 'Kiểm tra bộ nhớ đệm đã hoàn thành' },
  { name: 'Devanagari', text: 'डेटाबेस कैश की जाँच पूरी हुई' },
  { name: 'Arabic', text: 'تم التحقق من ذاكرة التخزين المؤقت' },
  { name: 'Japanese', text: 'バンド設定のデバッグを完了しました' },
  { name: 'stacked-diacritic Latin', text: 'Ǻrsrapport Ẫnh nguyễn phở' },
];

const migrated = createTestDb();
const db = migrated.handle.raw;
const declaration = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'memory_fts'`).get().sql;
const inherited = inheritedFts5Arguments(declaration);

db.exec(`CREATE VIRTUAL TABLE temp.t USING fts5(${['body', ...inherited].join(', ')})`);
db.exec(`CREATE VIRTUAL TABLE temp.t_inst USING fts5vocab('t','instance')`);
const insert = db.prepare('INSERT INTO temp.t(rowid, body) VALUES (?, ?)');
SAMPLES.forEach((s, i) => insert.run(i + 1, s.text));

const pad = (s, w) => String(s).padEnd(w);

console.log(`memory_fts declaration: ${declaration.replace(/\s+/g, ' ')}`);
console.log(`inherited fts5 arguments: ${inherited.length > 0 ? inherited.join(', ') : '(none)'}`);
console.log(`sqlite: ${db.prepare('select sqlite_version() v').get().v}\n`);
console.log(
  pad('sample', 32),
  pad('app', 4),
  pad('index', 6),
  pad('absent', 12),
  'terms the index does not hold',
);

const rows = [];
for (const [i, sample] of SAMPLES.entries()) {
  const appTerms = [...new Set(indexTerms(sample.text))];
  const indexTermSet = new Set(
    db
      .prepare('SELECT DISTINCT term FROM temp.t_inst WHERE doc = ?')
      .all(i + 1)
      .map((r) => r.term),
  );
  const absent = appTerms.filter((t) => !indexTermSet.has(t));
  rows.push({ sample, appTerms, indexTermSet, absent });
  const pct = appTerms.length === 0 ? 0 : Math.round((absent.length / appTerms.length) * 100);
  console.log(
    pad(sample.name, 32),
    pad(appTerms.length, 4),
    pad(indexTermSet.size, 6),
    pad(`${absent.length} (${pct}%)`, 12),
    absent.join(' ') || '—',
  );
}

console.log('\nfull term lists, app versus index:');
for (const { sample, appTerms, indexTermSet } of rows) {
  console.log(`\n${sample.name}: ${sample.text}`);
  console.log(`  app  : ${appTerms.join(' ')}`);
  console.log(`  index: ${[...indexTermSet].join(' ')}`);
}
migrated.cleanup();
