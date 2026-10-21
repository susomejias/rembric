import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('dashboard navigation freshness policy', () => {
  it('compacts the footer only for the judgment comparison while keeping default page spacing', () => {
    const source = readFileSync(new URL('./command-bar.tsx', import.meta.url), 'utf8');
    const main = source.match(/<main\s+className="([^"]+)"/)?.[1];
    expect(main).toContain('has-[>.judgment-detail]:pb-4');
    expect(main).toContain('pb-12');
  });
  it('disables eager route prefetch on every command bar link', () => {
    const source = readFileSync(new URL('./command-bar.tsx', import.meta.url), 'utf8');
    const links = source.match(/<Link\b[^>]*>/g) ?? [];

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toMatch(/\bprefetch=\{false\}/);
  });
});
