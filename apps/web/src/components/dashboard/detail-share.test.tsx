import type * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DetailImageModule from './detail-image';
import type { DetailImage } from './detail-image';
import { DetailShare } from './detail-share';

import { DialogContent } from '@/components/ui/dialog';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  deps: [] as unknown[][],
  cleanups: [] as (void | (() => void))[],
  effectCursor: 0,
}));
vi.mock('react', async (original) => {
  const react = await original<typeof React>();
  return {
    ...react,
    useId: () => 'share-test',
    useRef: (value: unknown) => {
      const i = hooks.cursor++;
      hooks.slots[i] ??= { current: value };
      return hooks.slots[i];
    },
    useState: (value: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.slots)) hooks.slots[i] = value;
      return [
        hooks.slots[i],
        (next: unknown) => {
          hooks.slots[i] =
            typeof next === 'function'
              ? (next as (value: unknown) => unknown)(hooks.slots[i])
              : next;
        },
      ];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const i = hooks.effectCursor++;
      if (!hooks.deps[i] || deps.some((v, n) => v !== hooks.deps[i]?.[n])) {
        hooks.effects.push(() => {
          hooks.cleanups[i]?.();
          hooks.cleanups[i] = effect();
        });
        hooks.deps[i] = deps;
      }
    },
  };
});
const generate = vi.hoisted(() => vi.fn<typeof DetailImageModule.createDetailImage>());
vi.mock('./detail-image', async (original) => ({
  ...(await original<typeof DetailImageModule>()),
  createDetailImage: generate,
}));
const data: DetailImageModule.DetailShareData = {
  kind: 'memory',
  label: 'Memory',
  title: 'title',
  date: new Date(0),
  byline: 'Saved by pi',
  projectName: 'p',
  content: { text: 'body', mode: 'markdown', label: 'Full content' },
  tags: ['tag'],
};
type Props = {
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (event: { target: { checked: boolean } }) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  href?: string;
  download?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  src?: string;
  type?: string;
  tabIndex?: number;
  className?: string;
  'aria-label'?: string;
};
let nodes: ReactElement<Props>[];
function render() {
  hooks.cursor = 0;
  hooks.effectCursor = 0;
  nodes = [];
  function visit(node: ReactNode): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const element = node as ReactElement<Props>;
    nodes.push(element);
    visit(element.props.children);
  }
  visit(DetailShare({ data }));
  hooks.effects.splice(0).forEach((effect) => effect());
}
const text = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : node && typeof node === 'object' && 'props' in node
        ? text((node as ReactElement<Props>).props.children)
        : '';
const button = (label: string) =>
  nodes.find((n) => n.type === 'button' && n.props.onClick && text(n.props.children) === label)!;
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  render();
}
function open() {
  nodes.find((n) => n.props.onOpenChange)?.props.onOpenChange?.(true);
  render();
}
const image: DetailImage = {
  blob: new Blob(['png'], { type: 'image/png' }),
  width: 1080,
  height: 2400,
};
const createObjectURL = vi.fn(() => 'blob:preview');
const revokeObjectURL = vi.fn();
beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  hooks.slots = [];
  hooks.deps = [];
  hooks.effects = [];
  hooks.cleanups = [];
  generate.mockReset().mockResolvedValue(image);
  vi.stubGlobal(
    'File',
    class extends Blob {
      name: string;
      constructor(parts: BlobPart[], name: string, options: BlobPropertyBag) {
        super(parts, options);
        this.name = name;
      }
    },
  );
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  render();
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  vi.unstubAllGlobals();
});
describe('DetailShare', () => {
  it('uses the shared animated dialog without redundant format controls', () => {
    expect(nodes.some((node) => node.type === DialogContent)).toBe(true);
    const radios = nodes.filter((node) => node.type === 'input' && node.props.type === 'radio');
    expect(radios).toHaveLength(0);
  });
  it('prepares only when open and previews the actual PNG with measured dimensions and download fallback', async () => {
    expect(generate).not.toHaveBeenCalled();
    open();
    await settle();
    expect(nodes.some((n) => n.props.src === 'blob:preview')).toBe(true);
    expect(
      nodes.some((n) => n.props['aria-label'] === 'Image preview' && n.props.tabIndex === 0),
    ).toBe(true);
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('1080 × 2400');
    expect(
      nodes.some(
        (n) =>
          n.type === 'a' && n.props.href === 'blob:preview' && n.props.download?.endsWith('.png'),
      ),
    ).toBe(true);
    expect(button('Share image')).toBeUndefined();
    expect(button('Copy image')).toBeUndefined();
  });
  it('invalidates immediately and discards stale generation races, revoking URLs on close', async () => {
    let first!: (value: DetailImage) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    open();
    nodes
      .filter((n) => n.type === 'input' && n.props.type === 'checkbox')[1]!
      .props.onChange?.({ target: { checked: false } });
    render();
    await settle();
    first({ ...image, height: 1111 });
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).not.toContain('1111');
    expect(nodes.some((n) => n.props.src === 'blob:preview')).toBe(true);
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('1080 × 2400');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    nodes
      .find((n) => n.type === 'input' && n.props.type === 'checkbox')!
      .props.onChange?.({ target: { checked: false } });
    render();
    expect(nodes.some((n) => n.props.src === 'blob:preview')).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    await settle();
    nodes.find((n) => n.props.onOpenChange)?.props.onOpenChange?.(false);
    render();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('shares the exact prepared File; cancellation is silent and real rejection is surfaced', async () => {
    const share = vi
      .fn<(data: ShareData) => Promise<void>>()
      .mockRejectedValue(new DOMException('cancel', 'AbortError'));
    const canShare = vi.fn((_data: ShareData) => true);
    vi.stubGlobal('navigator', { share, canShare });
    open();
    await settle();
    button('Share image').props.onClick?.();
    await settle();
    expect(share.mock.calls[0]?.[0].files?.[0]).toBe(canShare.mock.calls[0]?.[0].files?.[0]);
    expect(nodes.map((n) => text(n.props.children)).join('')).not.toMatch(
      /cancel|Shared image|Could not share/,
    );
    share.mockRejectedValueOnce(new Error('denied'));
    button('Share image').props.onClick?.();
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('denied');
  });
  it('falls back when the exact file is refused or capability checking throws', async () => {
    const share = vi.fn();
    const canShare = vi.fn(() => false);
    vi.stubGlobal('navigator', { share, canShare });
    open();
    await settle();
    expect(button('Share image')).toBeUndefined();
    expect(nodes.some((n) => n.type === 'a' && n.props.download)).toBe(true);
    canShare.mockImplementation(() => {
      throw new Error('unsupported');
    });
    render();
    expect(button('Share image')).toBeUndefined();
    expect(share).not.toHaveBeenCalled();
  });
  it('does not allocate a preview after unmount and only reports sharing after resolution', async () => {
    let complete!: (value: DetailImage) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    open();
    hooks.cleanups.forEach((cleanup) => cleanup?.());
    complete(image);
    await settle();
    expect(createObjectURL).not.toHaveBeenCalled();
    let shared!: () => void;
    const share = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          shared = resolve;
        }),
    );
    vi.stubGlobal('navigator', { share, canShare: () => true });
    nodes.find((n) => n.props.onOpenChange)?.props.onOpenChange?.(false);
    render();
    open();
    await settle();
    button('Share image').props.onClick?.();
    render();
    expect(nodes.map((n) => text(n.props.children)).join('')).not.toContain('Image shared.');
    shared();
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('Image shared.');
  });
  it('only reports clipboard success after write resolves and surfaces generation failure', async () => {
    const write = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public data: unknown) {}
      },
    );
    vi.stubGlobal('navigator', { clipboard: { write } });
    open();
    await settle();
    button('Copy image').props.onClick?.();
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('clipboard denied');
    write.mockResolvedValueOnce(undefined);
    button('Copy image').props.onClick?.();
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('Image copied');
    generate.mockRejectedValueOnce(new Error('Font failed'));
    nodes
      .filter((n) => n.type === 'input' && n.props.type === 'checkbox')[1]!
      .props.onChange?.({ target: { checked: false } });
    render();
    await settle();
    expect(nodes.map((n) => text(n.props.children)).join('')).toContain('Font failed');
    expect(button('Retry image')).toBeDefined();
  });
});
