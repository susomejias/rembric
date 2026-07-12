import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptSearchSh = join(here, '..', 'scripts', 'prompt-search.sh');
const NUDGE =
  'rembric: User intent: recall. Call memory.search with the user keywords before responding.';

function runPromptSearch(stdin: string): string {
  return execFileSync('bash', [promptSearchSh], { input: stdin, encoding: 'utf8' });
}

describe('prompt-search.sh (self-filtering, independent of the hook matcher)', () => {
  it('emits the nudge when the prompt matches a recall keyword', () => {
    const out = runPromptSearch(
      JSON.stringify({ prompt: 'can you recall what we did yesterday?' }),
    );
    expect(out.trim()).toBe(NUDGE);
  });

  it('matches case-insensitively', () => {
    const out = runPromptSearch(JSON.stringify({ prompt: 'Remember what we discussed?' }));
    expect(out.trim()).toBe(NUDGE);
  });

  it('matches the Spanish keyword variants', () => {
    const out = runPromptSearch(JSON.stringify({ prompt: '¿Acuérdate de lo que hicimos?' }));
    expect(out.trim()).toBe(NUDGE);
  });

  it('stays silent when the prompt does not match any recall keyword', () => {
    const out = runPromptSearch(JSON.stringify({ prompt: 'please fix the failing test' }));
    expect(out.trim()).toBe('');
  });

  it('falls through and emits the nudge when stdin has no prompt field', () => {
    const out = runPromptSearch(JSON.stringify({ session_id: 'abc' }));
    expect(out.trim()).toBe(NUDGE);
  });

  it('falls through and emits the nudge when stdin is empty', () => {
    const out = runPromptSearch('');
    expect(out.trim()).toBe(NUDGE);
  });
});
