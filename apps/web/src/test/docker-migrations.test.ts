import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

it('Docker and both CI boot gates accept the complete SQL inventory and reject missing or extra migrations', () => {
  const count = readdirSync(join(root, 'packages/db/src/migrations')).filter((name) =>
    name.endsWith('.sql'),
  ).length;
  expect(count).toBeGreaterThan(0);
  const gates = ['apps/web/Dockerfile', '.github/workflows/ci.yml'].flatMap((path) => [
    ...readFileSync(join(root, path), 'utf8').matchAll(
      /\[ "\$(migrations|applied)" (?:-eq|=) \d+ \]/g,
    ),
  ]);
  expect(gates).toHaveLength(3);
  for (const gate of gates) {
    for (const actual of [count - 1, count, count + 1]) {
      const result = spawnSync('sh', ['-c', `${gate[1]}=${actual}; ${gate[0]}`]);
      expect(result.status, `${gate[0]} with ${actual} migrations`).toBe(actual === count ? 0 : 1);
    }
  }
});
