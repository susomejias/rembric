import { describe, expect, it, vi } from 'vitest';

import type * as extractorRules from '@rembric/core';
import type { ExtractorRule } from '@rembric/core';

type Permutation = (rules: ExtractorRule[]) => ExtractorRule[];

async function extractedSet(text: string, permute: Permutation): Promise<Set<string>> {
  vi.resetModules();
  vi.doMock('./extractor-rules.js', async (importOriginal) => {
    const actual = await importOriginal<typeof extractorRules>();
    return { ...actual, EXTRACTOR_RULES: permute([...actual.EXTRACTOR_RULES]) };
  });
  const { extractEntities } = await import('@rembric/core');
  return new Set(extractEntities('', text).map((e) => `${e.kind}:${e.value}`));
}

const PERMUTATIONS: Record<string, Permutation> = {
  reversed: (rules) => rules.reverse(),
  'by kind name': (rules) => rules.sort((a, b) => a.kind.localeCompare(b.kind)),
};

const OVER_BUDGET = [
  Array.from({ length: 400 }, (_, i) => `node_modules/pkg${i}/dist/index.js`).join('\n'),
  'fixed in #4242, failed with ENOENT, set $DEPLOY_TOKEN, commit cfb5c04, host nas.local',
].join('\n');

const UNDER_BUDGET =
  'apps/server/src/db/migrate.ts threw ERR_MODULE_NOT_FOUND on nas.local; ' +
  'see PROJ-12 and #7, commit cfb5c04, NODE_ENV=production, $DATABASE_URL, 192.168.1.50';

const CONTESTED = [
  Array.from({ length: 300 }, (_, i) => `src/mod${i}/index.ts`).join('\n'),
  Array.from({ length: 150 }, (_, i) => `#${1000 + i}`).join(' '),
  Array.from({ length: 150 }, (_, i) => `PROJ-${1000 + i}`).join(' '),
  Array.from({ length: 300 }, (_, i) => `$DEPLOY_TOKEN_${1000 + i}`).join(' '),
].join('\n');

describe.each([
  ['over the budget', OVER_BUDGET],
  ['under the budget', UNDER_BUDGET],
  ['with several kinds contesting the budget', CONTESTED],
])('extractEntities — permuting the registry (%s)', (_label, text) => {
  it.each(Object.keys(PERMUTATIONS))('yields the same set with the registry %s', async (name) => {
    const declared = await extractedSet(text, (rules) => rules);
    expect(declared.size).toBeGreaterThan(5);
    expect(await extractedSet(text, PERMUTATIONS[name]!)).toEqual(declared);
  });
});
