import { createRepositories } from '@rembric/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../../test/db';

import {
  createWrappedImage,
  formatWrappedCount,
  wrappedEntityRows,
  wrappedEntityMemoryRows,
  WRAPPED_IMAGE_SIZES,
} from './wrapped-image';

afterEach(() => vi.unstubAllGlobals());

it.each(['square', 'story'] as const)(
  'exports entity data and partial coverage in %s PNG',
  async (format) => {
    const t = createTestDb();
    try {
      const data = createRepositories(t.handle.db).wrapped.adminYear(2026, Date.UTC(2026, 5, 1));
      data.entities = {
        total: 12,
        recurring: 3,
        scannedMemories: 2,
        eligibleMemories: 5,
        kinds: [{ kind: 'path', n: 12 }],
        memoryKinds: [{ kind: 'path', n: 2 }],
      };
      data.agents = [{ agent: 'Pi', n: 6 }];
      data.sessions = 6;
      data.projects = 2;
      data.projectMemories = {
        top: [
          { name: 'Confidential workspace', n: 10 },
          { name: 'confidential-slug', n: 2 },
        ],
        other: 0,
      };
      const text: string[] = [];
      const textBaselines: number[] = [];
      const context = {
        fillText: (value: string, _x: number, y: number) => {
          text.push(value);
          textBaselines.push(y);
        },
        measureText: (value: string) => ({ width: value.length * 8 }),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        roundRect: vi.fn(),
        fill: vi.fn(),
        createRadialGradient: () => ({ addColorStop: vi.fn() }),
        drawImage: vi.fn(),
        save: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        restore: vi.fn(),
      };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (cb: (blob: Blob) => void) => cb(new Blob(['png'], { type: 'image/png' })),
      };
      vi.stubGlobal('document', {
        createElement: () => canvas,
        documentElement: {},
        fonts: { load: () => Promise.resolve([]), ready: Promise.resolve(), check: () => true },
      });
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'Geist' }));
      vi.stubGlobal(
        'Image',
        class {
          decode() {
            return Promise.resolve();
          }
        },
      );
      expect((await createWrappedImage(data, format)).type).toBe('image/png');
      expect(canvas).toMatchObject(WRAPPED_IMAGE_SIZES[format]);
      expect(text).toContain('6 sessions');
      expect(text.join(' ')).not.toMatch(/Confidential workspace|confidential-slug|Project [1-4]/);
      expect(canvas.height - Math.max(...textBaselines)).toBeGreaterThanOrEqual(
        format === 'story' ? 80 : 40,
      );
      expect(text).toEqual(
        expect.arrayContaining([
          '12',
          'entities',
          'Paths 12',
          'Partial index · 2 / 5 project memories scanned',
          'active projects',
        ]),
      );
      text.length = 0;
      data.entities.scannedMemories = 5;
      await createWrappedImage(data, format);
      expect(text.some((value) => value.includes('Partial index'))).toBe(false);
      text.length = 0;
      data.entities = {
        total: 0,
        recurring: 0,
        scannedMemories: 0,
        eligibleMemories: 0,
        kinds: [],
        memoryKinds: [],
      };
      await createWrappedImage(data, format);
      expect(text).toContain('No indexed entities yet');
    } finally {
      t.cleanup();
    }
  },
);

describe('Wrapped entity mix', () => {
  it('keeps every memory-count type in the viewer instead of folding types into Other', () => {
    const rows = wrappedEntityMemoryRows([
      { kind: 'path', n: 9 },
      { kind: 'url', n: 8 },
      { kind: 'ticket', n: 7 },
      { kind: 'error_code', n: 6 },
      { kind: 'hostname', n: 5 },
      { kind: 'uuid', n: 4 },
    ]);
    expect(rows).toEqual([
      { label: 'Paths', n: 9 },
      { label: 'URLs', n: 8 },
      { label: 'Tickets', n: 7 },
      { label: 'Error codes', n: 6 },
      { label: 'Hostnames', n: 5 },
      { label: 'UUIDs', n: 4 },
    ]);
    expect(wrappedEntityMemoryRows([])).toEqual([]);
  });
  it('uses fixed labels and folds the tail into Other without changing totals', () => {
    expect(
      wrappedEntityRows([
        { kind: 'path', n: 12 },
        { kind: 'url', n: 8 },
        { kind: 'ticket', n: 7 },
        { kind: 'error_code', n: 4 },
        { kind: 'hostname', n: 2 },
        { kind: 'uuid', n: 1 },
      ]),
    ).toEqual([
      { label: 'Paths', n: 12 },
      { label: 'URLs', n: 8 },
      { label: 'Tickets', n: 7 },
      { label: 'Error codes', n: 4 },
      { label: 'Other', n: 3 },
    ]);
    expect(wrappedEntityRows([])).toEqual([]);
    expect(wrappedEntityRows([{ kind: 'path', n: 1 }])).toEqual([{ label: 'Paths', n: 1 }]);
  });
});

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
