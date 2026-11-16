import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button, buttonVariants } from './button';
import { Input } from './input';

function classes(value: string): string[] {
  return value.split(' ');
}

describe('controls follow the shadcn standard spacing', () => {
  it.each([
    ['default', ['h-9', 'px-4', 'gap-2', 'has-[>svg]:px-3']],
    ['sm', ['h-8', 'px-3', 'gap-1.5']],
    ['lg', ['h-10', 'px-6', 'gap-2']],
    ['icon', ['size-9']],
  ] as const)('sizes %s buttons', (size, expected) => {
    expect(classes(buttonVariants({ size }))).toEqual(expect.arrayContaining([...expected]));
  });

  it('gives fields the height of a default button so they line up', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain('h-9');
    expect(classes(buttonVariants())).toContain('h-9');
  });

  it('offers an amber warn variant for reversible but consequential actions', () => {
    const html = renderToStaticMarkup(<Button variant="warn">Archive</Button>);
    expect(html).toContain('data-variant="warn"');
    expect(html).toContain('text-warn');
    expect(html).not.toContain('bg-primary');
  });
});
