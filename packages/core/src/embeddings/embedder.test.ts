import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMS, embeddingInput, loadEmbedder } from '@rembric/core';

describe('embeddingInput', () => {
  it('prepends the title to the content so the headline shapes the vector', () => {
    expect(embeddingInput('Dashboard timezone fix', 'use formatTs helper')).toBe(
      'Dashboard timezone fix\n\nuse formatTs helper',
    );
  });
});

const smoke = process.env['REMBRIC_EMBEDDER_SMOKE'] === '1';

describe.skipIf(!smoke)('embedder smoke (real model)', () => {
  it(
    'embeds a fixed pair within the recorded similarity bounds',
    { timeout: 180_000 },
    async () => {
      const embedder = await loadEmbedder();
      const a = await embedder.embed('purge empty sessions from the database');
      const b = await embedder.embed('empty sessions get deleted from the database');
      const c = await embedder.embed('the dashboard uses a brutalist dark theme');

      expect(a.length).toBe(EMBEDDING_DIMS);

      const cos = (x: Float32Array, y: Float32Array): number => {
        let s = 0;
        for (let i = 0; i < x.length; i++) s += x[i]! * y[i]!;
        return s;
      };
      const same = cos(a, b);
      const unrelated = cos(a, c);
      expect(same).toBeGreaterThan(0.7);
      expect(unrelated).toBeLessThan(0.65);
      expect(same - unrelated).toBeGreaterThan(0.05);
    },
  );
});
