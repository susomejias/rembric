import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiagnostics, type DbDiagnostics } from '../db/diagnostics.js';
import { doctorReport } from '../test/doctor.js';
import { createTestDb, type TestDb } from '../test/index.js';

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => db.cleanup());

function report(diagnostics: DbDiagnostics) {
  return doctorReport(db.handle, db.dataDir, diagnostics);
}

describe('memory.doctor db block', () => {
  it('reports the three fields that vary and none claiming the database is healthy', () => {
    const out = report(createDiagnostics(db.handle));

    expect(Object.keys(out.db).sort()).toEqual(['integrity', 'journalMode', 'sizeBytes']);
    expect(out.db.integrity).toBe('ok');
    expect(out.warnings).toEqual([]);
  });

  it('surfaces a failed pragma read through warnings and integrity, and still returns a report', () => {
    const live = createDiagnostics(db.handle);
    const out = report({
      ...live,
      readJournalMode: () => {
        throw new Error('pragma journal_mode unavailable');
      },
      quickCheck: () => {
        throw new Error('pragma quick_check unavailable');
      },
    });

    expect(out.db.journalMode).toBe('unknown');
    expect(out.db.integrity).toBe('unknown');
    expect(out.warnings.some((w) => w.includes('pragma journal_mode unavailable'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('db integrity: unknown'))).toBe(true);
  });
});
