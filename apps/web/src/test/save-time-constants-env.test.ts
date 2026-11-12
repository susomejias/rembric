import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ROOTS = ['apps/web/src', 'packages/core/src', 'packages/mcp/src', 'packages/db/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function envReadsOf(name: string): string[] {
  const read = new RegExp(
    `process\\.env\\.${name}\\b|process\\.env\\[\\s*['"\`]${name}['"\`]|['"\`]${name}['"\`]`,
  );
  return ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))).filter((file) =>
    read.test(readFileSync(file, 'utf8')),
  );
}

describe('save-time candidate constants are not environment-configurable', () => {
  it('the scan sees the one operator knob that IS read from the environment', () => {
    expect(envReadsOf('CANDIDATES_PER_SAVE_MAX').length).toBeGreaterThan(0);
  });

  it.each([
    'CANDIDATE_POOL_SIZE',
    'COMMON_TERM_DOCUMENT_RATIO',
    'ENTITY_RARITY_MIN_LINKS',
    'LEXICAL_CANDIDATE_FLOOR',
  ])('%s is never read from the environment', (name) => {
    expect(envReadsOf(name)).toEqual([]);
  });
});

describe('the README documents only the save-time setting the server reads', () => {
  it('names CANDIDATES_PER_SAVE_MAX and no candidate threshold variable', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const documented = new Set([...readme.matchAll(/`(CANDIDATE[A-Z_]*)`/g)].map((m) => m[1]));
    expect([...documented]).toEqual(['CANDIDATES_PER_SAVE_MAX']);
    expect(envReadsOf('CANDIDATES_PER_SAVE_MAX').length).toBeGreaterThan(0);
  });
});
