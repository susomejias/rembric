import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('dashboard navigation freshness policy', () => {
  it('disables eager route prefetch on every command bar link', () => {
    const source = readFileSync(new URL('./command-bar.tsx', import.meta.url), 'utf8');
    const links = source.match(/<Link\b[^>]*>/g) ?? [];

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toMatch(/\bprefetch=\{false\}/);
  });
});
