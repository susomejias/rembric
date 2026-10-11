import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NumberTicker } from './number-ticker';

import { formatWrappedCount } from '@/components/dashboard/wrapped-image';

describe('NumberTicker accessible counts', () => {
  it('announces the exact value while rendering the compact glyphs', () => {
    const html = renderToStaticMarkup(
      createElement(NumberTicker, {
        value: 11200,
        format: formatWrappedCount,
        ariaLabel: '11,200',
        startOnView: false,
      }),
    );
    expect(html).toContain('class="sr-only">11,200</span>');
    expect(html).toContain('>k</span>');
  });
  it('keeps the existing accessible formatting when no override is supplied', () => {
    const html = renderToStaticMarkup(
      createElement(NumberTicker, {
        value: 42,
        prefix: '+',
        suffix: ' sessions',
      }),
    );
    expect(html).toContain('class="sr-only">+42 sessions</span>');
  });
});
