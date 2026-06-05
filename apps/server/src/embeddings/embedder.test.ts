import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMS, loadEmbedder } from './embedder.js';

/**
 * Real-model smoke test, guarding the transformers.js `NewModel →
 * EncoderOnly` fallback (see embedder.ts header). Loads the actual q8
 * artifacts, so it only runs when explicitly requested — the Docker e2e
 * exercises it unconditionally:
 *
 *   REMBRIC_EMBEDDER_SMOKE=1 pnpm vitest run src/embeddings/embedder.test.ts
 *
 * First local run downloads the model (~300 MB) into the HF cache.
 */

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
      // Bounds derived from the 2026-06-05 calibration battery (q8, cls,
      // normalized), with platform-variance margin. A dependency upgrade
      // that breaks the EncoderOnly fallback shifts these dramatically.
      const same = cos(a, b);
      const unrelated = cos(a, c);
      expect(same).toBeGreaterThan(0.7);
      expect(unrelated).toBeLessThan(0.65);
      expect(same - unrelated).toBeGreaterThan(0.05);
    },
  );
});
