import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const stopNudgeSh = join(here, '..', 'scripts', 'stop-nudge.sh');
const promptNudgeSh = join(here, '..', 'scripts', 'prompt-nudge.sh');

let counterDir: string;
let dir: string;

beforeEach(() => {
  counterDir = mkdtempSync(join(tmpdir(), 'rbr-stopnudge-'));
  dir = mkdtempSync(join(tmpdir(), 'rbr-stopnudge-tx-'));
});
afterEach(() => {
  rmSync(counterDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function run(script: string, stdin: string, agent?: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', agent ? [script, agent] : [script], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir, ...env },
  });
}

/** Advances the shared counter exactly as a real turn would. */
function advanceTurn(sessionId: string): void {
  run(promptNudgeSh, JSON.stringify({ session_id: sessionId }));
}

function toolTranscript(name = 'tx.jsonl'): string {
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'fix the parser' }] } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/p.ts' } }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: false, content: 'ok' }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm test' } }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }],
      },
    },
  ];
  const p = join(dir, name);
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

function stdin(sessionId: string, transcriptPath?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });
}

describe('stop-nudge.sh — end-of-turn summary reminder', () => {
  it('fires on turn 1 and carries the rubric plus the extracted facts', () => {
    const tx = toolTranscript();
    advanceTurn('s1');
    const out = run(stopNudgeSh, stdin('s1', tx));
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('memory.session_summary');
    expect(ctx).toContain('Decisions+why');
    expect(ctx).toContain('/repo/p.ts');
    expect(ctx).toContain('failed commands:');
  });

  // The load-bearing assertion: this must never be able to hold a turn open.
  it('never emits an interrupting decision', () => {
    const tx = toolTranscript();
    advanceTurn('s2');
    const out = run(stopNudgeSh, stdin('s2', tx));
    expect(out).not.toContain('"decision"');
    expect(out).not.toContain('block');
    expect(out).not.toContain('"continue"');
  });

  it('is silent on turns between cadence points, and fires again at 10', () => {
    const tx = toolTranscript();
    advanceTurn('s3');
    expect(run(stopNudgeSh, stdin('s3', tx))).not.toBe('');
    for (let turn = 2; turn <= 9; turn += 1) {
      advanceTurn('s3');
      expect(run(stopNudgeSh, stdin('s3', tx)), `turn ${turn}`).toBe('');
    }
    advanceTurn('s3');
    expect(run(stopNudgeSh, stdin('s3', tx))).not.toBe('');
  });

  // If this hook advanced the counter instead of peeking, every cadence keyed on
  // it would silently halve: two increments per turn.
  it('does not advance the shared counter', () => {
    const tx = toolTranscript();
    advanceTurn('s4');
    const counterFile = join(counterDir, 'rembric-turnnudge', 's4');
    const before = readFileSync(counterFile, 'utf8').length;
    run(stopNudgeSh, stdin('s4', tx));
    run(stopNudgeSh, stdin('s4', tx));
    expect(readFileSync(counterFile, 'utf8').length).toBe(before);
  });

  it('is silent when the session has nothing extractable', () => {
    advanceTurn('s5');
    const plain = join(dir, 'plain.jsonl');
    writeFileSync(
      plain,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    );
    expect(run(stopNudgeSh, stdin('s5', plain))).toBe('');
  });

  it('is silent when no transcript path is supplied', () => {
    advanceTurn('s6');
    expect(run(stopNudgeSh, stdin('s6'))).toBe('');
  });

  it('is silent when the counter has never been written (no turn recorded)', () => {
    const tx = toolTranscript();
    expect(run(stopNudgeSh, stdin('never-seen', tx))).toBe('');
  });

  it('exits 0 and emits nothing on empty or unparseable stdin', () => {
    expect(run(stopNudgeSh, '')).toBe('');
    expect(run(stopNudgeSh, 'not json {{{')).toBe('');
  });

  // The cost MOVED here, so the budget has to move with it: a ~250-byte nudge at
  // the start of the turn became a facts payload at the end. Without a bound this
  // injects ~7 KB per cadence point, which is what the extraction produces on a
  // real session.
  it('bounds the injected payload, and says when it dropped earlier facts', () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `w${i}`,
                name: 'Write',
                input: { file_path: `/repo/gen/file-with-a-long-name-${i}.ts` },
              },
            ],
          },
        }),
      );
    }
    const big = join(dir, 'big.jsonl');
    writeFileSync(big, `${lines.join('\n')}\n`);
    advanceTurn('s8');
    const out = run(stopNudgeSh, stdin('s8', big));
    const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx.length).toBeLessThan(2600);
    expect(ctx).toContain('earlier facts omitted');
    // Still grounded: the rubric survives the bound, since only the facts are cut.
    expect(ctx).toContain('Decisions+why');
  });

  // Found by the e2e, not by a unit test: the hook makes no request, so it never
  // checked configuration and reminded the model to call a tool that is not
  // reachable. The spec required this and the code did not do it.
  it('is silent when no server is configured', () => {
    const tx = toolTranscript('unconf.jsonl');
    advanceTurn('s9');
    const bare = { ...process.env, TMPDIR: counterDir };
    delete bare.REMBRIC_SERVER_URL;
    delete bare.REMBRIC_API_TOKEN;
    const out = execFileSync('bash', [stopNudgeSh], {
      input: stdin('s9', tx),
      encoding: 'utf8',
      env: bare,
    });
    expect(out).toBe('');
  });

  it('emits a JSON object rather than nothing for codex-cli when silent', () => {
    expect(run(stopNudgeSh, stdin('s7'), 'codex-cli')).toBe('{}');
  });
});

describe('prompt-nudge.sh no longer carries the every-10 summary reminder', () => {
  it('still reminds on turn 1, because that is protocol rather than a reminder', () => {
    expect(run(promptNudgeSh, JSON.stringify({ session_id: 'p1' }))).toContain(
      'memory.session_summary',
    );
  });

  it('does not repeat the summary reminder at turn 10 — stop-nudge.sh owns that now', () => {
    for (let i = 0; i < 9; i += 1) advanceTurn('p2');
    const tenth = run(promptNudgeSh, JSON.stringify({ session_id: 'p2' }));
    expect(tenth).toContain('memory.save now');
    // NOT `not.toContain('memory.session_summary')`: the sessionId line's own
    // template names that tool, so the absence to assert is the reminder's text.
    expect(tenth).not.toContain('did real work happen this turn?');
  });
});
