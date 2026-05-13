import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Append-only contract invariants enforced as a CI grep gate.
 *
 * The product makes load-bearing claims about memory immutability:
 *   - no row is ever DELETEd from the `memory` table
 *   - the `content` column is never UPDATEd
 *
 * Both are also enforced in the application layer, but a static check
 * shouts loudly if a future PR introduces a regression in a service we
 * haven't yet covered with unit tests. The check scans every .ts file
 * under src/ (except this file and migrations) and fails if forbidden
 * SQL fragments appear.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

const FORBIDDEN: { pattern: RegExp; description: string }[] = [
  {
    pattern: /delete\s*\(\s*memory\s*\)/i,
    description: 'Drizzle `db.delete(memory)` is forbidden — memory is append-only',
  },
  {
    pattern: /DELETE\s+FROM\s+memory\b/i,
    description: 'raw `DELETE FROM memory` is forbidden — memory is append-only',
  },
  {
    pattern: /update\([^)]*memory[^)]*\)[^.]*\.set\([^)]*content\s*:/i,
    description: '`db.update(memory).set({ content: … })` is forbidden — content is immutable',
  },
  {
    pattern: /UPDATE\s+memory\b[^;]*\bSET\s+content\s*=/i,
    description: 'raw `UPDATE memory SET content = …` is forbidden — content is immutable',
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'migrations') continue; // raw SQL migrations are exempt
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('append-only invariants (static grep)', () => {
  const files = listSourceFiles(srcRoot);

  it('discovers source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, description } of FORBIDDEN) {
    it(`forbids: ${description}`, () => {
      const offenders: { file: string; line: number; text: string }[] = [];
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Skip comments — a comment may legitimately reference the
          // forbidden pattern when documenting the invariant itself.
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }
          if (pattern.test(line)) {
            offenders.push({ file, line: i + 1, text: line.trim() });
          }
        }
      }
      if (offenders.length > 0) {
        const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
        throw new Error(`${description}\n${formatted}`);
      }
    });
  }
});
