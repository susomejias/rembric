import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button, buttonVariants } from './button';
import { Input } from './input';
import { SelectTrigger } from './select';

function classes(value: string): string[] {
  return value.split(' ');
}

describe('controls follow the shadcn new-york spacing', () => {
  it.each([
    ['default', ['h-9', 'px-4', 'py-2', 'gap-2', 'has-[>svg]:px-3']],
    ['xs', ['h-6', 'px-2', 'gap-1', 'has-[>svg]:px-1.5']],
    ['sm', ['h-8', 'px-3', 'gap-1.5', 'has-[>svg]:px-2.5']],
    ['lg', ['h-10', 'px-6', 'gap-2', 'has-[>svg]:px-4']],
    ['icon', ['size-9']],
    ['icon-xs', ['size-6']],
    ['icon-sm', ['size-8']],
    ['icon-lg', ['size-10']],
  ] as const)('sizes %s buttons', (size, expected) => {
    expect(classes(buttonVariants({ size }))).toEqual(expect.arrayContaining([...expected]));
  });

  it('gives fields the height of a default button so they line up', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain('h-9');
    expect(classes(buttonVariants())).toContain('h-9');
  });

  it('sizes select triggers like default and small buttons', () => {
    const trigger = SelectTrigger({ size: 'sm' }) as { props: { className: string } };
    expect(classes(trigger.props.className)).toEqual(
      expect.arrayContaining(['data-[size=default]:h-9', 'data-[size=sm]:h-8', 'px-3']),
    );
  });

  it('offers an amber warn variant for reversible but consequential actions', () => {
    const html = renderToStaticMarkup(<Button variant="warn">Archive</Button>);
    expect(html).toContain('data-variant="warn"');
    expect(html).toContain('text-warn');
    expect(html).not.toContain('bg-primary');
  });
});
