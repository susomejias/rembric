import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UpdateProgress, type UpdateProgressPreview } from './update-progress';

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

function render(preview: UpdateProgressPreview | null): string {
  return renderToStaticMarkup(<UpdateProgress initialVersion={VERSION} preview={preview} />);
}

describe('UpdateProgress', () => {
  it('renders the four hand-off steps in order, all idle before the first poll', () => {
    const html = render(null);

    expect(stepStates(html)).toEqual({
      backup: 'idle',
      pull: 'idle',
      restart: 'idle',
      verify: 'idle',
    });
    expect(html).not.toContain('data-pull-progress');
    expect(html).not.toContain('Update failed');
  });

  it('marks the backup step active during the backup phase', () => {
    expect(stepStates(render({ phase: 'backup', pull: null }))).toEqual({
      backup: 'active',
      pull: 'idle',
      restart: 'idle',
      verify: 'idle',
    });
  });

  it('marks the pull step active and shows the layer progress', () => {
    const html = render({ phase: 'pull', pull: { done: 3, total: 9 } });

    expect(stepStates(html)).toEqual({
      backup: 'done',
      pull: 'active',
      restart: 'idle',
      verify: 'idle',
    });
    expect(html).toContain('3/9 layers');
  });

  it('stops at the restart step during the launch phase', () => {
    expect(stepStates(render({ phase: 'launch', pull: null }))).toEqual({
      backup: 'done',
      pull: 'done',
      restart: 'active',
      verify: 'idle',
    });
  });

  it('verifies the new version once the swap is handed off', () => {
    expect(stepStates(render({ phase: 'restarting', pull: null }))).toEqual({
      backup: 'done',
      pull: 'done',
      restart: 'active',
      verify: 'active',
    });
  });
});
