import { describe, expect, it } from 'vitest';

import { EMBEDDING_MAX_TOKENS, loadEmbedder } from '@rembric/core';

describe('embedder input cap (real model)', () => {
  it(
    'ignores text past EMBEDDING_MAX_TOKENS, and still reads text before it',
    { timeout: 180_000 },
    async () => {
      const embedder = await loadEmbedder();
      // About twice the cap, and well under the model's own 8192-token limit, so only the cap cuts it.
      const head = 'the nimbus scheduler listens on port 8781. '.repeat(EMBEDDING_MAX_TOKENS / 5);
      const capped = await embedder.embed(head);
      const withTail = await embedder.embed(`${head} the dashboard uses a dark theme`);
      expect(Array.from(withTail)).toEqual(Array.from(capped));

      const short = await embedder.embed('the nimbus scheduler listens on port 8781');
      const shortWithTail = await embedder.embed(
        'the nimbus scheduler listens on port 8781. the dashboard uses a dark theme',
      );
      expect(Array.from(shortWithTail)).not.toEqual(Array.from(short));
    },
  );
});
