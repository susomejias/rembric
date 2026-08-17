import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  createSessionProtocol,
  FIRST_PROMPT_NUDGE,
  RESUMED_READ_NUDGE,
  SESSION_OPENING_NUDGE,
  SESSION_OPENING_NUDGE_CORE,
  POST_COMPACT_NUDGE_CORE,
  SESSION_ID_NUDGE_TEMPLATE,
} from '../bin/rembric-plugin-core.mjs';

/**
 * The remaining client-composed nudge texts are the lock-step contract shared
 * with the bash (scripts/prompt-nudge.sh, scripts/prompt-search.sh), JS/TS
 * (bin/rembric-plugin-core.mjs, imported by every JS/TS client), and Python
 * (.hermes-plugin/__init__.py) implementations. Bash and the shared JS/TS
 * module embed the SAME `rembric:`-prefixed strings verbatim (asserted
 * directly here); Python wraps each hint in `<memory-hint>...</memory-hint>`
 * tags, so its lock-step check unwraps the tag and compares the shared core
 * text (the `…Core` fixture keys).
 *
 * The stretch-close reminder (`session-nudges`) is server-composed and has
 * NO fixture: every client prints what the server hands it, and its own
 * 640-byte bound is asserted against the emitted string on the server
 * (apps/server/src/services/session-nudge.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  sessionIdCoreTemplate: string;
  sessionIdTemplate: string;
  firstPromptRelevanceCore: string;
  firstPromptRelevance: string;
  postCompact: string;
  postCompactCore: string;
  recall: string;
  resumedReadCore: string;
  resumedRead: string;
  sessionStart: string;
  sessionOpeningCore: string;
  sessionOpening: string;
};

function sessionIdLine(sessionId: string): string {
  return fixtures.sessionIdTemplate.replace('{{SESSION_ID}}', sessionId);
}

/**
 * The budget unit is pinned by claude-code-plugin's token-budget requirement as
 * UTF-8 bytes ÷ 4. `.length` undercounts because `≤ · —` are multi-byte, which
 * is why the same post-compact block has two published token figures.
 */
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** 36 chars: the sessionId line's cap is stated for a rendered UUID. */
const UUID_SESSION_ID = '0189d5f2-6c3a-7b4e-9f21-8c7d6e5a4b30';

const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');
const promptSearchSh = join(here, '..', 'scripts', 'prompt-search.sh');
const postCompactSh = join(here, '..', 'scripts', 'post-compact.sh');
const hermesInit = join(here, '..', '.hermes-plugin', '__init__.py');
const pluginCoreMjs = join(here, '..', 'bin', 'rembric-plugin-core.mjs');

const hasPython3 = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
    | '_SAVE_HINT_URGENT'
    | '_SESSION_ID_HINT_TEMPLATE'
    | '_RELEVANCE_HINT'
    | '_RESUMED_READ_HINT'
    | '_SESSION_OPENING_HINT'
    | '_POST_COMPACT_HINT',
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

function runPromptNudge(sessionId: string, counterDir: string): string {
  return execFileSync('bash', [promptNudgeSh], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
}

function markCreated(counterDir: string, sessionId: string): void {
  const dir = join(counterDir, 'rembric-created');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), '1');
}

describe('sessionId nudge template lock-step across bash, TS, and Python', () => {
  it('bash and TS share the exact rembric:-prefixed sessionId template', () => {
    expect(SESSION_ID_NUDGE_TEMPLATE).toBe(fixtures.sessionIdTemplate);
  });

  it.runIf(hasPython3)("Python's template matches once wrapped in <memory-hint>", () => {
    const hint = pythonHintConstant('_SESSION_ID_HINT_TEMPLATE');
    expect(hint).toBe(`<memory-hint>${fixtures.sessionIdCoreTemplate}</memory-hint>`);
  });

  it('interpolating a known session id produces the same final string for bash and TS', () => {
    const testId = 'sess-lockstep-test-1';
    const expected = fixtures.sessionIdTemplate.replace('{{SESSION_ID}}', testId);
    expect(SESSION_ID_NUDGE_TEMPLATE.replace('{{SESSION_ID}}', testId)).toBe(expected);
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
    expect(FIRST_PROMPT_NUDGE).toBe(fixtures.firstPromptRelevance);
  });

  it.runIf(hasPython3)(
    "Python's _RELEVANCE_HINT wraps the exact shared core text in <memory-hint> tags",
    () => {
      const hint = pythonHintConstant('_RELEVANCE_HINT');
      expect(hint).toBe(`<memory-hint>${fixtures.firstPromptRelevanceCore}</memory-hint>`);
    },
  );
});

describe('resumedRead fixture lock-step across bash, TS, and Python', () => {
  it('the fixture text is the rembric:-prefixed shared core', () => {
    expect(fixtures.resumedRead).toBe(`rembric: ${fixtures.resumedReadCore}`);
  });

  it('TS matches the exact fixture text', () => {
    expect(RESUMED_READ_NUDGE).toBe(fixtures.resumedRead);
  });

  it.runIf(hasPython3)(
    "Python's _RESUMED_READ_HINT wraps the exact shared core text in <memory-hint> tags",
    () => {
      const hint = pythonHintConstant('_RESUMED_READ_HINT');
      expect(hint).toBe(`<memory-hint>${fixtures.resumedReadCore}</memory-hint>`);
    },
  );

  it('bash prompt-nudge.sh emits the exact fixture text for a resumed session, without the sessionId line', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      const dir = join(counterDir, 'rembric-resumed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 's-fixture-resumed'), '1');
      const out = runPromptNudge('s-fixture-resumed', counterDir);
      expect(out.trim()).toBe(fixtures.resumedRead);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });
});

describe('sessionOpening fixture lock-step across bash, TS, and Python', () => {
  it('the fixture text is the rembric:-prefixed shared core', () => {
    expect(fixtures.sessionOpening).toBe(`rembric: ${fixtures.sessionOpeningCore}`);
  });

  it('TS matches the exact fixture text', () => {
    expect(SESSION_OPENING_NUDGE).toBe(fixtures.sessionOpening);
    expect(SESSION_OPENING_NUDGE_CORE).toBe(fixtures.sessionOpeningCore);
  });

  it.runIf(hasPython3)(
    "Python's _SESSION_OPENING_HINT wraps the exact shared core text in <memory-hint> tags",
    () => {
      const hint = pythonHintConstant('_SESSION_OPENING_HINT');
      expect(hint).toBe(`<memory-hint>${fixtures.sessionOpeningCore}</memory-hint>`);
    },
  );

  it('bash prompt-nudge.sh emits the sessionId line + the exact fixture opening text, once, on a newly created session', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-nudgefixture-'));
    try {
      markCreated(counterDir, 's-fixture-opening');
      const first = runPromptNudge('s-fixture-opening', counterDir);
      expect(first.trim()).toBe(
        `${sessionIdLine('s-fixture-opening')}\n${fixtures.sessionOpening}`,
      );
      const second = runPromptNudge('s-fixture-opening', counterDir);
      expect(second).toBe('');
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('says "before you finish this turn", never "now"', () => {
    expect(fixtures.sessionOpeningCore).toContain('before you finish this turn');
    expect(fixtures.sessionOpeningCore).not.toMatch(/\bnow\b/);
  });

  it('names ## Goal and states the other five headings are left out', () => {
    expect(fixtures.sessionOpeningCore).toContain('## Goal');
    expect(fixtures.sessionOpeningCore).toMatch(/other five canonical headings/);
  });
});

// The JS/TS clients contribute only a transport, so the core's own emission is
// the only place the order can be pinned for all of them at once.
describe('the shared JS/TS core: nudgesForTurn order and no-cadence contract', () => {
  const core = () =>
    createSessionProtocol({
      agent: 'nudge-order-fixture',
      serverUrl: 'http://127.0.0.1:1',
      apiToken: 'unused-no-request-is-made',
      slug: 'nudge-order',
    });

  it('emits only the first-prompt line on turn 1 of an unregistered session', () => {
    const protocol = core();
    expect(protocol.nudgesForTurn('s-quiet', 'a plain prompt about nothing')).toEqual([
      FIRST_PROMPT_NUDGE,
    ]);
  });

  it('emits nothing on a later turn of the same session', () => {
    const protocol = core();
    protocol.nudgesForTurn('s-quiet-2', 'first');
    expect(protocol.nudgesForTurn('s-quiet-2', 'second')).toEqual([]);
  });

  it('declares no cadence constant, no modulo, no save/summary nudge text', () => {
    const src = readFileSync(pluginCoreMjs, 'utf8');
    expect(src).not.toMatch(/SAVE_NUDGE|SUMMARY_NUDGE_EVERY|SAVE_NUDGE_EVERY/);
    expect(src).not.toContain('userTurnCounts');
  });
});

/**
 * post-compact.sh's PROTOCOL block fires at SessionStart(matcher:"compact")
 * on Claude Code AND Codex CLI — both run this exact script, so it is
 * byte-identical across the two by construction. opencode's compaction
 * handler (`experimental.session.compacting` in .opencode-plugin/plugin.ts)
 * sources the same core text via rembric-plugin-core.mjs's
 * POST_COMPACT_NUDGE_CORE plus its own slug sentence — pinned in
 * plugin.test.ts, not here, since it runs through the TS handler rather
 * than this bash script.
 */
describe('post-compact.sh PROTOCOL block (Claude Code + Codex CLI)', () => {
  function runPostCompact(cwd: string): string {
    return execFileSync('bash', [postCompactSh], {
      input: JSON.stringify({ session_id: 's-postcompact-fixture', cwd }),
      encoding: 'utf8',
    }).trimEnd();
  }

  it('emits the exact fixture text', () => {
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

  it('states the merge rule (sent sections REPLACE, omitted ones STAY), not a whole-document replacement', () => {
    expect(fixtures.postCompact).toMatch(/REPLACE/);
    expect(fixtures.postCompact).toMatch(/STAY/);
    expect(fixtures.postCompact).not.toContain('this REPLACES the stored value');
  });

  it('contains no non-ASCII Spanish-only characters (¿ ¡ é í ó ú ñ)', () => {
    expect(fixtures.postCompact).not.toMatch(/[¿¡éíóúñÑ]/);
  });

  it('stays within its byte budget (≤700 bytes / 175 tokens)', () => {
    expect(bytes(fixtures.postCompact)).toBeLessThanOrEqual(700);
  });
});

describe('postCompactCore fixture lock-step across the shared JS/TS core and Python (opencode-plugin)', () => {
  it('the fixture text is the postCompact fixture minus its rembric: prefix', () => {
    expect(fixtures.postCompactCore).toBe(fixtures.postCompact.replace(/^rembric: /, ''));
  });

  it('the shared JS/TS core matches the fixture exactly', () => {
    expect(POST_COMPACT_NUDGE_CORE).toBe(fixtures.postCompactCore);
  });

  it.runIf(hasPython3)(
    "Python's _POST_COMPACT_HINT wraps the exact shared core text in <memory-hint> tags",
    () => {
      const hint = pythonHintConstant('_POST_COMPACT_HINT');
      expect(hint).toBe(`<memory-hint>${fixtures.postCompactCore}</memory-hint>`);
    },
  );

  it('stays within the same 700-byte budget as postCompact, with margin to spare', () => {
    expect(bytes(fixtures.postCompactCore)).toBeLessThanOrEqual(700);
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

  it('sessionIdTemplate rendered with a 36-char id ≤224 bytes (56 tokens)', () => {
    expect(bytes(sessionIdLine(UUID_SESSION_ID))).toBeLessThanOrEqual(224);
  });

  it('sessionOpening ≤360 bytes (90 tokens)', () => {
    expect(bytes(fixtures.sessionOpening)).toBeLessThanOrEqual(360);
  });

  it('resumedRead ≤160 bytes (40 tokens)', () => {
    expect(bytes(fixtures.resumedRead)).toBeLessThanOrEqual(160);
  });

  it('postCompact ≤700 bytes (175 tokens)', () => {
    expect(bytes(fixtures.postCompact)).toBeLessThanOrEqual(700);
  });

  it('the fixtures carry no save, saveCore, summary, summaryCore or endOfTurnRubric key', () => {
    for (const key of ['save', 'saveCore', 'summary', 'summaryCore', 'endOfTurnRubric']) {
      expect(Object.prototype.hasOwnProperty.call(fixtures, key), key).toBe(false);
    }
  });
});

/**
 * The per-firing-turn ceiling (session-nudges, claude-code-plugin) is derived
 * from firstPromptRelevance + recall + sessionIdTemplate + the notice's own
 * 640-byte bound + 4 newlines. The notice itself has no fixture (it is
 * composed server-side per session), so the worst case is reconstructed here
 * from a SYNTHETIC 640-byte string standing in for it — the real end-to-end
 * figure is measured against a live server in the PR description (task 8.3).
 */
describe('UserPromptSubmit emitted-output budgets', () => {
  it('turn 1 with a recall keyword stays ≤800 bytes (200 tokens): this sub-budget does NOT move', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-turn1-'));
    try {
      const env = { ...process.env, TMPDIR: counterDir };
      const input = JSON.stringify({
        session_id: UUID_SESSION_ID,
        prompt: 'what did we do yesterday',
      });
      const search = execFileSync('bash', [promptSearchSh], { input, encoding: 'utf8', env });
      const nudge = execFileSync('bash', [promptNudgeSh], { input, encoding: 'utf8', env });
      expect(bytes(search) + bytes(nudge)).toBeLessThanOrEqual(800);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('the worst reachable turn (first-prompt + recall + sessionId + a 640-byte notice) stays ≤1088 bytes', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-worst-'));
    try {
      const env = { ...process.env, TMPDIR: counterDir };
      const input = JSON.stringify({
        session_id: UUID_SESSION_ID,
        prompt: 'what did we do yesterday',
      });
      const search = execFileSync('bash', [promptSearchSh], { input, encoding: 'utf8', env });

      const syntheticNotice = 'x'.repeat(640);
      const dir = join(counterDir, 'rembric-pending');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, UUID_SESSION_ID), syntheticNotice);
      const nudge = execFileSync('bash', [promptNudgeSh], { input, encoding: 'utf8', env });

      expect(bytes(search) + bytes(nudge)).toBeLessThanOrEqual(1088);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });

  it('a conversation with no work costs only the turn-1 lines, over twenty turns', () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'rembric-budget-quiet-'));
    try {
      const env = { ...process.env, TMPDIR: counterDir };
      let total = 0;
      for (let turn = 1; turn <= 20; turn += 1) {
        const input = JSON.stringify({ session_id: 's-quiet-20', prompt: 'continue the refactor' });
        const search = execFileSync('bash', [promptSearchSh], { input, encoding: 'utf8', env });
        const nudge = execFileSync('bash', [promptNudgeSh], { input, encoding: 'utf8', env });
        total += bytes(search) + bytes(nudge);
      }
      // Turn 1 alone: firstPromptRelevance plus its one trailing newline.
      expect(total).toBe(bytes(fixtures.firstPromptRelevance) + 1);
      expect(total).toBeLessThan(1880);
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  });
});

describe.runIf(hasPython3)('no cadence constant remains in the Python provider', () => {
  it('declares no _SAVE_HINT_EVERY, _SUMMARY_HINT_EVERY, _SAVE_HINT, or _SUMMARY_HINT', () => {
    const src = readFileSync(hermesInit, 'utf8');
    expect(src).not.toContain('_SAVE_HINT_EVERY');
    expect(src).not.toContain('_SUMMARY_HINT_EVERY');
    expect(src).not.toMatch(/_SAVE_HINT\s*=/);
    expect(src).not.toMatch(/_SUMMARY_HINT\s*=/);
  });

  it('_SAVE_HINT_URGENT survives unchanged (unrelated to the periodic reminder)', () => {
    const hint = pythonHintConstant('_SAVE_HINT_URGENT');
    expect(hint).toContain('save anything important');
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
  // The PUBLISHED spec: `server-gated-session-nudges` is archived, so the
  // capability file now carries these numbers. It pointed at that change's
  // delta while it was unarchived, because the published file still held the
  // pre-change 960/180 until the archive phase merged it.
  const spec = readFileSync(
    join(here, '..', '..', '..', 'openspec', 'specs', 'claude-code-plugin', 'spec.md'),
    'utf8',
  );

  it.each([100, 140, 224, 360, 700, 1088, 240])(
    'the %s cap is stated in claude-code-plugin/spec.md',
    (cap) => {
      expect(spec).toMatch(new RegExp(`\\b${cap}\\b`));
    },
  );
});
