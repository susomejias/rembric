import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression tests for the per-agent transcript parsers in
 * `plugin/scripts/_transcript.sh`.
 *
 * The parsers are coupled to the JSONL shapes emitted by each host
 * agent's transcript file. If Claude Code or Codex CLI ever change the
 * shape of those files in a way the parser doesn't anticipate, the
 * fallback path in our SessionEnd / Stop hooks would silently emit an
 * empty summary, which is exactly the bug we fixed in
 * `fix-session-summary-all-clients`.
 *
 * These tests run the bash parsers against synthetic fixtures that
 * mirror the real-world shapes observed in production (May 2026 — see
 * `fixtures/transcripts/*.jsonl` for the documented examples). If a
 * future host change reshapes the JSONL, these tests will fail loudly
 * and the parser can be updated before the regression hits users.
 *
 * Both `jq` and the awk-only fallback are exercised to keep parity
 * between the two code paths.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptsDir = join(repoRoot, 'plugin', 'scripts');
const transcriptHelper = join(scriptsDir, '_transcript.sh');
const fixturesDir = join(here, 'fixtures', 'transcripts');

interface ParserCase {
  agent: 'claude_code' | 'codex_cli';
  fixture: string;
  expectedTranscriptLines: string[];
  expectedTitle: string;
}

const CASES: ParserCase[] = [
  {
    agent: 'claude_code',
    fixture: 'claude-code.jsonl',
    expectedTranscriptLines: [
      'user: Hola, dame la hora',
      'assistant: Son las 2026-05-16; no tengo acceso a la hora exacta.',
      'user: Lista los archivos del directorio src/',
      'assistant: Contenido de src/: cli.ts, config.ts, index.ts',
      'user: Cuántos tests',
      'assistant: 368 tests pasando.',
    ],
    expectedTitle: 'Son las 2026-05-16; no tengo acceso a la hora exacta.',
  },
  {
    agent: 'codex_cli',
    fixture: 'codex-cli.jsonl',
    expectedTranscriptLines: [
      'user: hola!',
      'assistant: ¡Hola! ¿En qué te ayudo hoy?',
      'user: cuántos tests tiene este repo',
      'assistant: 368 tests pasando, todos verdes.',
    ],
    expectedTitle: '¡Hola! ¿En qué te ayudo hoy?',
  },
];

function runBash(script: string, hideJq: boolean): string {
  // Spawn a fresh bash that sources the helper, runs the function, and
  // prints the result. Empty stdout is a valid (empty) parser output.
  const env = { ...process.env };
  if (hideJq) {
    // Strip Homebrew + common jq locations from PATH so the awk path is
    // exercised. `awk` ships with macOS BSD / Linux gawk, so it stays
    // available even with a minimal PATH.
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env,
  });
}

function callParser(fn: string, fixturePath: string, hideJq: boolean): string {
  // `source` the helper, call the function, print result without trailing newline.
  const cmd = `source "${transcriptHelper}"; ${fn} "${fixturePath}"`;
  return runBash(cmd, hideJq);
}

describe.each(CASES)(
  'transcript parser · $agent',
  ({ agent, fixture, expectedTranscriptLines, expectedTitle }) => {
    const fixturePath = join(fixturesDir, fixture);

    describe.each([
      { name: 'jq path', hideJq: false },
      { name: 'awk fallback', hideJq: true },
    ])('$name', ({ hideJq }) => {
      it('format extracts user/assistant lines in order', () => {
        const out = callParser(`rembric_format_transcript_${agent}`, fixturePath, hideJq);
        const lines = out.split('\n').filter((l) => l.length > 0);
        expect(lines).toEqual(expectedTranscriptLines);
      });

      it('format drops non-conversation rows (metadata noise)', () => {
        const out = callParser(`rembric_format_transcript_${agent}`, fixturePath, hideJq);
        // No line should mention any of the noise type names.
        const noiseTypes = [
          'session_meta',
          'turn_context',
          'response_item',
          'token_count',
          'reasoning',
          'task_started',
          'task_complete',
          'function_call',
          'mcp_tool_call_end',
          'last-prompt',
          'permission-mode',
          'attachment',
          'file-history-snapshot',
          'ai-title',
          'queue-operation',
        ];
        for (const noise of noiseTypes) {
          expect(out, `should not leak ${noise} into formatted output`).not.toContain(noise);
        }
      });

      it('format never emits empty user:/assistant: lines', () => {
        const out = callParser(`rembric_format_transcript_${agent}`, fixturePath, hideJq);
        // Every conversation line must have content after the role prefix.
        const lines = out.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          expect(line, `line must have non-empty content: ${JSON.stringify(line)}`).toMatch(
            /^(user|assistant): \S/,
          );
        }
      });

      it('extract_first_assistant returns the first non-empty assistant message', () => {
        const title = callParser(`rembric_extract_first_assistant_${agent}`, fixturePath, hideJq);
        expect(title).toBe(expectedTitle);
      });

      it('returns empty for a non-existent transcript path', () => {
        const out = callParser(
          `rembric_format_transcript_${agent}`,
          '/tmp/does-not-exist-rembric-test.jsonl',
          hideJq,
        );
        expect(out).toBe('');
      });

      it('returns empty for an empty file', () => {
        const empty = join(fixturesDir, '__empty__.jsonl');
        execFileSync('bash', ['-c', `: > "${empty}"`], { encoding: 'utf8' });
        try {
          const out = callParser(`rembric_format_transcript_${agent}`, empty, hideJq);
          expect(out).toBe('');
        } finally {
          execFileSync('bash', ['-c', `rm -f "${empty}"`], { encoding: 'utf8' });
        }
      });
    });
  },
);
