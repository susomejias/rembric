import { describe, expect, it } from 'vitest';

import { formatWrappedCount } from './wrapped-image';

describe('Wrapped compact counts', () => {
  it.each([
    [0, '0'],
    [35, '35'],
    [999, '999'],
    [1000, '1k'],
    [11200, '11.2k'],
    [11249, '11.2k'],
    [999949, '999.9k'],
    [999950, '1M'],
    [1300000, '1.3M'],
    [2300000000, '2.3B'],
    [4500000000000, '4.5T'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatWrappedCount(value)).toBe(expected);
  });
});
