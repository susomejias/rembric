import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contextSchema, memorySearchSchema } from '@rembric/mcp';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('rerank constants are not configuration', () => {
  it('no MCP input schema of a reranked surface takes a rerank parameter', () => {
    for (const schema of [memorySearchSchema, contextSchema]) {
      expect(Object.keys(schema).filter((k) => /rerank/i.test(k))).toEqual([]);
    }
  });

  it('the environment reaches reranking only through the REMBRIC_RERANK switch', () => {
    const files = ['apps/web/src', 'packages/core/src', 'packages/mcp/src'].flatMap((d) =>
      sources(join(root, d)),
    );
    const envReads = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/process\.env(?:\[['"]|\.)(\w*RERANK\w*)/g)].map(
        (m) => m[1],
      ),
    );
    expect(new Set(envReads)).toEqual(new Set(['REMBRIC_RERANK']));
  });
});
