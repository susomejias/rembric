import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { SUMMARY_SECTIONS } from '../../server/src/mcp/summary-rubric.js';

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
  sessionIdCoreTemplate: string;
  sessionIdTemplate: string;
  postCompact: string;
  endOfTurnRubric: string;
  firstPromptRelevanceCore: string;
  firstPromptRelevance: string;
};

function sessionIdLine(sessionId: string): string {
  return fixtures.sessionIdTemplate.replace('{{SESSION_ID}}', sessionId);
}

/**
 * The budget unit is pinned by claude-code-plugin's token-budget requirement as
 * UTF-8 bytes ÷ 4. `.length` undercounts because `≤ · —` are multi-byte, which
 * is why the same post-compact block has two published token figures.
 */
const BYTES_PER_TOKEN = 4;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** 36 chars: the sessionId line's cap is stated for a rendered UUID. */
const UUID_SESSION_ID = '0189d5f2-6c3a-7b4e-9f21-8c7d6e5a4b30';

const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const stopNudgeSh = join(here, '..', 'scripts', 'stop-nudge.sh');
const promptSearchSh = join(here, '..', 'scripts', 'prompt-search.sh');
const postCompactSh = join(here, '..', 'scripts', 'post-compact.sh');
const stopNudgeShPath = join(here, '..', 'scripts', 'stop-nudge.sh');
const sessionStartSh = join(here, '..', 'scripts', 'session-start.sh');
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

function tsSessionIdTemplate(): string {
  const src = readFileSync(opencodePluginTs, 'utf8');
  const match = src.match(/const SESSION_ID_NUDGE_TEMPLATE =\s*\n?\s*'((?:[^'\\]|\\.)*)';/);
  if (!match) throw new Error('SESSION_ID_NUDGE_TEMPLATE not found in plugin.ts');
  return match[1];
}

function tsFirstPromptNudge(): string {
  const src = readFileSync(opencodePluginTs, 'utf8');
  const match = src.match(/const FIRST_PROMPT_NUDGE =\s*\n?\s*'((?:[^'\\]|\\.)*)';/);
  if (!match) throw new Error('FIRST_PROMPT_NUDGE not found in plugin.ts');
  return match[1];
}

function bashFirstPromptNudge(sessionId: string, counterDir: string): string[] {
  const out = execFileSync('bash', [promptSearchSh], {
    input: JSON.stringify({ session_id: sessionId, prompt: 'anything without a keyword' }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
  return out.split('\n').filter((l) => l.length > 0);
}

function pythonHintConstant(
  name:
    | '_SAVE_HINT'
    | '_SAVE_HINT_URGENT'
    | '_SUMMARY_HINT'
    | '_SESSION_ID_HINT_TEMPLATE'
    | '_RELEVANCE_HINT',
): string {
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

// SAVE_NUDGE_EVERY lives in prompt-nudge.sh (start of turn); SUMMARY_NUDGE_EVERY
// moved to stop-nudge.sh (end of turn), where the reminder can actually be acted
// on. The NUMBER must still match every other client's, because the in-process
// clients have no end-of-turn event and keep firing it themselves — the cadence
// is shared even though the firing point is not.
function bashCadence(name: 'SAVE_NUDGE_EVERY' | 'SUMMARY_NUDGE_EVERY'): number {
  const file = name === 'SUMMARY_NUDGE_EVERY' ? stopNudgeSh : promptNudgeSh;
  const match = readFileSync(file, 'utf8').match(new RegExp(`^${name}=(\\d+)$`, 'm'));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return Number(match[1]);
}

function tsCadence(name: 'SAVE_NUDGE_EVERY' | 'SUMMARY_NUDGE_EVERY'): number {
  const match = readFileSync(opencodePluginTs, 'utf8').match(new RegExp(`const ${name} = (\\d+);`));
  if (!match) throw new Error(`${name} not found in plugin.ts`);
  return Number(match[1]);
}

describe('nudge text lock-step across bash and TS', () => {
  let counterDir: string;

  it('bash prompt-nudge.sh emits the sessionId line + the exact fixture save text on turn 5', () => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const lines = bashNudgesOnTurn(5, 's-fixture-save', counterDir);
      expect(lines).toEqual([sessionIdLine('s-fixture-save'), fixtures.save]);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('bash prompt-nudge.sh emits the sessionId line + the exact fixture summary text on turn 1', () => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const lines = bashNudgesOnTurn(1, 's-fixture-summary', counterDir);
      expect(lines).toEqual([sessionIdLine('s-fixture-summary'), fixtures.summary]);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('bash prompt-nudge.sh omits the sessionId line when session_id is unknown', () => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      let out = '';
      for (let i = 1; i <= 5; i++) {
        out = execFileSync('bash', [promptNudgeSh], {
          input: '{}',
          encoding: 'utf8',
          env: { ...process.env, TMPDIR: counterDir },
        });
      }
      const lines = out.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual([fixtures.save]);
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

  it('the fixture sessionId template is the rembric:-prefixed shared core template', () => {
    expect(fixtures.sessionIdTemplate).toBe(`rembric: ${fixtures.sessionIdCoreTemplate}`);
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

  it("Python's _SESSION_ID_HINT_TEMPLATE wraps the exact shared core template in <memory-hint> tags", () => {
    const hint = pythonHintConstant('_SESSION_ID_HINT_TEMPLATE');
    expect(hint).toBe(`<memory-hint>${fixtures.sessionIdCoreTemplate}</memory-hint>`);
  });
});

describe('sessionId nudge template lock-step across bash, TS, and Python', () => {
  it('bash and TS share the exact rembric:-prefixed sessionId template', () => {
    expect(tsSessionIdTemplate()).toBe(fixtures.sessionIdTemplate);
  });

  it.runIf(hasPython3)("Python's template matches once wrapped in <memory-hint>", () => {
    const hint = pythonHintConstant('_SESSION_ID_HINT_TEMPLATE');
    expect(hint).toBe(`<memory-hint>${fixtures.sessionIdCoreTemplate}</memory-hint>`);
  });

  it('interpolating a known session id produces the same final string for bash and TS', () => {
    const testId = 'sess-lockstep-test-1';
    const expected = fixtures.sessionIdTemplate.replace('{{SESSION_ID}}', testId);
    expect(tsSessionIdTemplate().replace('{{SESSION_ID}}', testId)).toBe(expected);
  });
});

describe('first-prompt relevance nudge lock-step across bash, TS, and Python', () => {
  it('the fixture text is the rembric:-prefixed shared core', () => {
    expect(fixtures.firstPromptRelevance).toBe(`rembric: ${fixtures.firstPromptRelevanceCore}`);
  });

  it('bash prompt-search.sh emits the exact fixture text on the first prompt of a session', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const lines = bashFirstPromptNudge('s-fixture-relevance', counterDir);
      expect(lines).toContain(fixtures.firstPromptRelevance);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('bash prompt-search.sh does not re-fire it on the second prompt of the same session', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      bashFirstPromptNudge('s-fixture-relevance-2', counterDir);
      const lines = bashFirstPromptNudge('s-fixture-relevance-2', counterDir);
      expect(lines).not.toContain(fixtures.firstPromptRelevance);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('TS matches the exact fixture text', () => {
    expect(tsFirstPromptNudge()).toBe(fixtures.firstPromptRelevance);
  });

  it.runIf(hasPython3)(
    "Python's _RELEVANCE_HINT wraps the exact shared core text in <memory-hint> tags",
    () => {
      const hint = pythonHintConstant('_RELEVANCE_HINT');
      expect(hint).toBe(`<memory-hint>${fixtures.firstPromptRelevanceCore}</memory-hint>`);
    },
  );
});

describe('nudge cadence numbers lock-step across bash and TS', () => {
  it('SAVE_NUDGE_EVERY matches', () => {
    expect(tsCadence('SAVE_NUDGE_EVERY')).toBe(bashCadence('SAVE_NUDGE_EVERY'));
  });

  it('SUMMARY_NUDGE_EVERY matches', () => {
    expect(tsCadence('SUMMARY_NUDGE_EVERY')).toBe(bashCadence('SUMMARY_NUDGE_EVERY'));
  });
});

/**
 * post-compact.sh's PROTOCOL block fires at SessionStart(matcher:"compact")
 * on Claude Code AND Codex CLI — both run this exact script, so it is
 * byte-identical across the two by construction. It was previously emitted
 * in Spanish (the only non-English agent-facing text in the product); see
 * openspec/changes/fix-audited-defects. opencode has an independently-
 * authored post-compaction message (`experimental.session.compacting` in
 * .opencode-plugin/plugin.ts) that predates this fixture and is not forced
 * into byte-identity here — only Claude Code and Codex CLI actually share
 * this script's output today.
 */
describe('post-compact.sh PROTOCOL block (Claude Code + Codex CLI, fix-audited-defects)', () => {
  function runPostCompact(cwd: string): string {
    return execFileSync('bash', [postCompactSh], {
      input: JSON.stringify({ session_id: 's-postcompact-fixture', cwd }),
      encoding: 'utf8',
    }).trimEnd();
  }

  it('emits the exact fixture text (English, not the prior Spanish)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rembric-postcompact-'));
    try {
      expect(runPostCompact(cwd)).toBe(fixtures.postCompact);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is byte-identical whether invoked as Claude Code or as Codex CLI', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rembric-postcompact-'));
    try {
      const claudeOut = execFileSync('bash', [postCompactSh, 'claude-code'], {
        input: JSON.stringify({ session_id: 's-postcompact-fixture', cwd }),
        encoding: 'utf8',
      }).trimEnd();
      const codexOut = execFileSync('bash', [postCompactSh, 'codex-cli'], {
        input: JSON.stringify({ session_id: 's-postcompact-fixture', cwd }),
        encoding: 'utf8',
      }).trimEnd();
      expect(claudeOut).toBe(codexOut);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('contains no non-ASCII Spanish-only characters (¿ ¡ é í ó ú ñ)', () => {
    expect(fixtures.postCompact).not.toMatch(/[¿¡éíóúñÑ]/);
  });

  it('stays within its byte budget (≤600 bytes / 150 tokens)', () => {
    expect(bytes(fixtures.postCompact)).toBeLessThanOrEqual(600);
  });
});

/**
 * One assertion per row of the token-budget requirement's per-line table. Each
 * is its own `it` so a violation names exactly one line.
 */
describe('per-line byte budgets', () => {
  it('SessionStart nudge ≤100 bytes (25 tokens)', () => {
    expect(bytes(fixtures.sessionStart)).toBeLessThanOrEqual(100);
  });

  it('recall nudge ≤100 bytes (25 tokens)', () => {
    expect(bytes(fixtures.recall)).toBeLessThanOrEqual(100);
  });

  it('firstPromptRelevance ≤140 bytes (35 tokens)', () => {
    expect(bytes(fixtures.firstPromptRelevance)).toBeLessThanOrEqual(140);
  });

  it('save ≤132 bytes (33 tokens)', () => {
    expect(bytes(fixtures.save)).toBeLessThanOrEqual(132);
  });

  it('sessionIdTemplate rendered with a 36-char id ≤224 bytes (56 tokens)', () => {
    expect(bytes(sessionIdLine(UUID_SESSION_ID))).toBeLessThanOrEqual(224);
  });

  it('summary ≤260 bytes (65 tokens)', () => {
    expect(bytes(fixtures.summary)).toBeLessThanOrEqual(260);
  });
});

/**
 * The `UserPromptSubmit` cap is a per-firing-turn ceiling plus an amortised
 * budget, because the two matcher-less entries fire on cadences (turn 1,
 * every 5th, every 10th) — a flat per-turn figure is unsatisfiable by design.
 */
describe('UserPromptSubmit emitted-output budgets', () => {
  function turnBytes(counterDir: string, prompt: string): number {
    const env = { ...process.env, TMPDIR: counterDir };
    const input = JSON.stringify({ session_id: UUID_SESSION_ID, prompt });
    const search = execFileSync('bash', [promptSearchSh], { input, encoding: 'utf8', env });
    const nudge = execFileSync('bash', [promptNudgeSh], { input, encoding: 'utf8', env });
    return bytes(search) + bytes(nudge);
  }

  it('turn 1 with a recall keyword stays ≤720 bytes (180 tokens)', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-turn1-'));
    try {
      // Four lines at once: firstPrompt + recall + save + summary.
      expect(turnBytes(counterDir, 'what did we do yesterday')).toBeLessThanOrEqual(720);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  // The two scripts keep INDEPENDENT counters (`rembric-relevance-prefetch` vs
  // `rembric-turnnudge`) with nothing coupling them, so one can be at turn 1
  // while the other is at turn 10 and all five lines fire together. Reachable
  // for real: Codex records hook trust per handler, so trusting one script
  // before the other lands exactly here. Turn 1 is NOT the worst case.
  it('a turn where the two counters diverge stays ≤840 bytes (210 tokens)', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-diverged-'));
    try {
      for (let turn = 1; turn <= 9; turn += 1) turnBytes(counterDir, 'keep going');
      // Only the first-prompt counter is reset, so turn 10 of the nudge
      // cadence coincides with turn 1 of the relevance one.
      rmSync(join(counterDir, 'rembric-relevance-prefetch'), { recursive: true, force: true });
      const diverged = turnBytes(counterDir, 'what did we do yesterday');
      // Lower than it used to be (>720) because the summary reminder MOVED to
      // stop-nudge.sh. Asserted as a range rather than relaxed to a ceiling, so
      // moving it back — or adding a fourth line here — fails.
      expect(diverged).toBeGreaterThan(460);
      expect(diverged).toBeLessThanOrEqual(620);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('ten consecutive turns average ≤180 bytes/turn (45 tokens), seven emitting nothing', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-amortised-'));
    try {
      const perTurn = Array.from({ length: 10 }, () =>
        turnBytes(counterDir, 'continue with the refactor'),
      );
      const total = perTurn.reduce((sum, n) => sum + n, 0);
      expect(total / perTurn.length).toBeLessThanOrEqual(180);
      // The zero turns are what make the mean honest.
      for (const turn of [2, 3, 4, 6, 7, 8, 9]) {
        expect(perTurn[turn - 1]).toBe(0);
      }
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
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

/**
 * These two were emitted to a model from bash and from opencode's TS with no
 * fixture behind them, so nothing asserted the two copies agreed — the drift
 * surface the shared-fixture requirement exists to close.
 */
describe('the two script-emitted nudges are in lock-step with their clients', () => {
  const shellLiteral = (file: string, marker: string): string => {
    const line = readFileSync(join(here, '..', 'scripts', file), 'utf8')
      .split('\n')
      .find((l) => l.includes(marker));
    return line!.slice(line!.indexOf("'") + 1, line!.lastIndexOf("'"));
  };

  it('session-start.sh emits the sessionStart fixture verbatim', () => {
    expect(shellLiteral('session-start.sh', 'memory.context before responding')).toBe(
      fixtures.sessionStart,
    );
  });

  it('prompt-search.sh emits the recall fixture verbatim', () => {
    expect(shellLiteral('prompt-search.sh', 'User intent: recall')).toBe(fixtures.recall);
  });

  it("opencode's plugin emits the same recall line as bash", () => {
    const ts = readFileSync(join(here, '..', '.opencode-plugin', 'plugin.ts'), 'utf8');
    expect(ts).toContain(fixtures.recall);
  });
});

/**
 * The caps below live in two places by necessity — a prose contract and an
 * executing assertion — and nothing coupled them, so amending one silently left
 * the other. This asserts every cap this file enforces appears verbatim in the
 * published requirement, which is what makes a spec edit and a test edit fail
 * together instead of drifting apart.
 */
describe('every enforced cap is published in the capability that owns it', () => {
  const spec = readFileSync(
    join(here, '..', '..', '..', 'openspec', 'specs', 'claude-code-plugin', 'spec.md'),
    'utf8',
  );

  it.each([100, 140, 132, 224, 260, 600, 840, 210, 180])(
    'the %s cap is stated in claude-code-plugin/spec.md',
    (cap) => {
      expect(spec).toMatch(new RegExp(`\\b${cap}\\b`));
    },
  );
});

// The long-form rubric has no TypeScript consumer — the end-of-turn hook is bash
// — so the fixture is its source, the same way the short nudges work. The first
// version put it in a TS constant nothing read, while the text that actually
// shipped was written a second time in the hook with nothing comparing them.
describe('end-of-turn rubric lock-step', () => {
  it('stop-nudge.sh carries the exact fixture rubric', () => {
    expect(readFileSync(stopNudgeShPath, 'utf8')).toContain(fixtures.endOfTurnRubric);
  });

  it('the rubric names every canonical section', () => {
    for (const section of SUMMARY_SECTIONS.split(' · ')) {
      expect(fixtures.endOfTurnRubric, `rubric omits '${section}'`).toContain(section);
    }
  });
});
