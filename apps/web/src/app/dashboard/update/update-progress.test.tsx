import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { STATUS_MAX_MISSES, statusFailureMode, UpdateProgress } from './update-progress';

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

  it('tolerates transient status-probe failures before switching to version probing', () => {
    for (let misses = 1; misses < STATUS_MAX_MISSES; misses += 1) {
      expect(statusFailureMode(misses)).toBe('retry');
    }
    expect(statusFailureMode(STATUS_MAX_MISSES)).toBe('verify');
    expect(statusFailureMode(STATUS_MAX_MISSES + 10)).toBe('verify');
  });
});
