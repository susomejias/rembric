import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The save/summary nudge texts are the lock-step contract shared with the
 * bash (scripts/prompt-nudge.sh), TS (.opencode-plugin/plugin.ts), and Python
 * (.hermes-plugin/__init__.py) implementations. Bash and TS embed the SAME
 * `rembric:`-prefixed strings verbatim (asserted directly here); Python
 * wraps its summary hint in `<memory-hint>...</memory-hint>` tags following
 * its established convention (matching `_SAVE_HINT`'s existing wrapper), so
 * its lock-step check unwraps the tag and compares the shared core text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  save: string;
  summaryCore: string;
  summary: string;
};
const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const hermesInit = join(here, '..', '.hermes-plugin', '__init__.py');

function bashNudgesOnTurn(turn: number, sessionId: string, counterDir: string): string[] {
  let out = '';
  for (let i = 1; i <= turn; i++) {
    out = execFileSync('bash', [promptNudgeSh], {
      input: JSON.stringify({ session_id: sessionId }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: counterDir },
    });
  }
  return out.split('\n').filter((l) => l.length > 0);
}

function pythonHintConstant(name: '_SAVE_HINT' | '_SAVE_HINT_URGENT' | '_SUMMARY_HINT'): string {
  const program = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('rembric_hermes_plugin', sys.argv[1])",
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    `sys.stdout.write(getattr(mod, sys.argv[2]))`,
  ].join('\n');
  return execFileSync('python3', ['-c', program, hermesInit, name], { encoding: 'utf8' });
}

describe('nudge text lock-step across bash, TS, and Python', () => {
  let counterDir: string;

  it('bash prompt-nudge.sh emits the exact fixture save text on turn 5', () => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const lines = bashNudgesOnTurn(5, 's-fixture-save', counterDir);
      expect(lines).toEqual([fixtures.save]);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('bash prompt-nudge.sh emits the exact fixture summary text on turn 1', () => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const lines = bashNudgesOnTurn(1, 's-fixture-summary', counterDir);
      expect(lines).toEqual([fixtures.summary]);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it("Python's _SUMMARY_HINT wraps the exact shared core text in <memory-hint> tags", () => {
    const hint = pythonHintConstant('_SUMMARY_HINT');
    expect(hint).toBe(`<memory-hint>${fixtures.summaryCore}</memory-hint>`);
  });

  it('the fixture summary text is the rembric:-prefixed shared core', () => {
    expect(fixtures.summary).toBe(`rembric: ${fixtures.summaryCore}`);
  });
});
