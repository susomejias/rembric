import { describe, expect, it } from 'vitest';

import { createEmbedder, EMBEDDING_DIMS } from './embedder.js';

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
      const embedder = createEmbedder();
      const a = await embedder.embed('purgar las sesiones vacías de la base de datos');
      const b = await embedder.embed('purge empty sessions from the database');
      const c = await embedder.embed('el dashboard usa un tema oscuro brutalista');

      expect(a.length).toBe(EMBEDDING_DIMS);
      expect(embedder.isReady()).toBe(true);

      const cos = (x: Float32Array, y: Float32Array): number => {
        let s = 0;
        for (let i = 0; i < x.length; i++) s += x[i]! * y[i]!;
        return s;
      };
      // Bounds recorded from the 2026-06-05 sandbox battery (q8, cls,
      // normalized). A dependency upgrade that breaks the EncoderOnly
      // fallback shifts these dramatically.
      expect(cos(a, b)).toBeGreaterThan(0.75); // ES/EN same fact ≈ 0.83
      expect(cos(a, c)).toBeLessThan(0.6); // unrelated ≈ 0.43
    },
  );
});
