import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptSearchSh = join(here, '..', 'scripts', 'prompt-search.sh');
const RECALL_NUDGE =
  'rembric: User intent: recall. Call memory.search with the user keywords before responding.';
const FIRST_PROMPT_NUDGE =
  'rembric: New session — call memory.context with focus set to this prompt before responding, to surface relevant prior work.';

let counterDir: string;

beforeEach(() => {
  counterDir = mkdtempSync(join(tmpdir(), 'rembric-promptsearch-'));
});

afterEach(() => {
  rmSync(counterDir, { recursive: true, force: true });
});

function runPromptSearch(stdin: string): string {
  return execFileSync('bash', [promptSearchSh], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
}

describe('prompt-search.sh (self-filtering, independent of the hook matcher)', () => {
  it('the first prompt of a session emits the first-prompt nudge even without a recall keyword', () => {
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe(FIRST_PROMPT_NUDGE);
  });

  it('the second prompt of the same session does not re-fire the first-prompt nudge', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe('');
  });

  it('a new session gets its own first-prompt nudge independent of another session', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt of s1' }));
    const out = runPromptSearch(JSON.stringify({ session_id: 's2', prompt: 'unrelated prompt' }));
    expect(out.trim()).toBe(FIRST_PROMPT_NUDGE);
  });

  it('emits the recall nudge when the prompt matches a recall keyword, on any turn', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'can you recall what we did yesterday?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('matches case-insensitively', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'Remember what we discussed?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('matches the Spanish keyword variants', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: '¿Acuérdate de lo que hicimos?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('both nudges fire together when the first prompt of a session also matches a recall keyword', () => {
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'remember what we did?' }),
    );
    expect(out.trim().split('\n')).toEqual([FIRST_PROMPT_NUDGE, RECALL_NUDGE]);
  });

  it('stays fully silent on a later turn with no keyword match', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'turn one' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe('');
  });

  it('falls through and emits the recall nudge when stdin has no prompt field', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1' }));
    const out = runPromptSearch(JSON.stringify({ session_id: 's1' }));
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('falls through and emits the recall nudge when stdin is empty', () => {
    runPromptSearch('');
    const out = runPromptSearch('');
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('an unwritable counter dir fails closed on first-turn detection but keyword matching still works', () => {
    // TMPDIR pointing at a regular file (not a directory) makes
    // `mkdir -p "$TMPDIR/rembric-relevance-prefetch"` fail, so the counter
    // can never be written or read — the exact "COUNT unreadable" case.
    const notADir = join(counterDir, 'this-is-a-file-not-a-dir');
    writeFileSync(notADir, '');
    const out = execFileSync('bash', [promptSearchSh], {
      input: JSON.stringify({
        session_id: 's-broken-counter',
        prompt: 'please fix the failing test',
      }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: notADir },
    });
    expect(out.trim()).toBe('');
  });
});
