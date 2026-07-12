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
 * wraps both hints in `<memory-hint>...</memory-hint>` tags, so its
 * lock-step check unwraps the tag and compares the shared core text
 * (`saveCore`/`summaryCore`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  saveCore: string;
  save: string;
  summaryCore: string;
  summary: string;
};
const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const hermesInit = join(here, '..', '.hermes-plugin', '__init__.py');
const opencodePluginTs = join(here, '..', '.opencode-plugin', 'plugin.ts');

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

const hasPython3 = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

function pythonNumberConstant(name: '_SAVE_HINT_EVERY' | '_SUMMARY_HINT_EVERY'): number {
  const program = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('rembric_hermes_plugin', sys.argv[1])",
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'sys.stdout.write(str(getattr(mod, sys.argv[2])))',
  ].join('\n');
  return Number(execFileSync('python3', ['-c', program, hermesInit, name], { encoding: 'utf8' }));
}

function bashCadence(name: 'SAVE_NUDGE_EVERY' | 'SUMMARY_NUDGE_EVERY'): number {
  const match = readFileSync(promptNudgeSh, 'utf8').match(new RegExp(`^${name}=(\\d+)$`, 'm'));
  if (!match) throw new Error(`${name} not found in prompt-nudge.sh`);
  return Number(match[1]);
}

function tsCadence(name: 'SAVE_NUDGE_EVERY' | 'SUMMARY_NUDGE_EVERY'): number {
  const match = readFileSync(opencodePluginTs, 'utf8').match(new RegExp(`const ${name} = (\\d+);`));
  if (!match) throw new Error(`${name} not found in plugin.ts`);
  return Number(match[1]);
}

describe('nudge text lock-step across bash and TS', () => {
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

  it('the fixture summary text is the rembric:-prefixed shared core', () => {
    expect(fixtures.summary).toBe(`rembric: ${fixtures.summaryCore}`);
  });

  it('the fixture save text is the rembric:-prefixed shared core', () => {
    expect(fixtures.save).toBe(`rembric: ${fixtures.saveCore}`);
  });
});

describe.runIf(hasPython3)('nudge text lock-step with Python', () => {
  it("Python's _SUMMARY_HINT wraps the exact shared core text in <memory-hint> tags", () => {
    const hint = pythonHintConstant('_SUMMARY_HINT');
    expect(hint).toBe(`<memory-hint>${fixtures.summaryCore}</memory-hint>`);
  });

  it("Python's _SAVE_HINT wraps the exact shared core text in <memory-hint> tags", () => {
    const hint = pythonHintConstant('_SAVE_HINT');
    expect(hint).toBe(`<memory-hint>${fixtures.saveCore}</memory-hint>`);
  });
});

describe('nudge cadence numbers lock-step across bash and TS', () => {
  it('SAVE_NUDGE_EVERY matches', () => {
    expect(tsCadence('SAVE_NUDGE_EVERY')).toBe(bashCadence('SAVE_NUDGE_EVERY'));
  });

  it('SUMMARY_NUDGE_EVERY matches', () => {
    expect(tsCadence('SUMMARY_NUDGE_EVERY')).toBe(bashCadence('SUMMARY_NUDGE_EVERY'));
  });
});

describe.runIf(hasPython3)('nudge cadence numbers lock-step with Python', () => {
  it('SAVE_NUDGE_EVERY matches', () => {
    expect(pythonNumberConstant('_SAVE_HINT_EVERY')).toBe(bashCadence('SAVE_NUDGE_EVERY'));
  });

  it('SUMMARY_NUDGE_EVERY matches', () => {
    expect(pythonNumberConstant('_SUMMARY_HINT_EVERY')).toBe(bashCadence('SUMMARY_NUDGE_EVERY'));
  });
});
