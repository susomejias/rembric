import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UpdateProgress } from './update-progress';

const VERSION = '0.28.12';

function stepStates(html: string): Record<string, string> {
  const states: Record<string, string> = {};
  const re = /data-step="([^"]+)" data-state="([^"]+)"/g;
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    states[match[1] ?? ''] = match[2] ?? '';
    match = re.exec(html);
  }
  return states;
}

function render(): string {
  return renderToStaticMarkup(<UpdateProgress initialVersion={VERSION} />);
}

describe('UpdateProgress', () => {
  it('renders the four hand-off steps in order, all idle before the first poll', () => {
    const html = render();

    expect(stepStates(html)).toEqual({
      backup: 'idle',
      pull: 'idle',
      restart: 'idle',
      verify: 'idle',
    });
    expect(html).not.toContain('data-pull-progress');
    expect(html).not.toContain('Update failed');
  });
});
