import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// `apps/plugin/scripts` is this file's sibling directory.
const scriptsDir = join(here, '..', 'scripts');
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

let jqlessPathDir: string | null = null;
function buildJqlessPath(): string {
  if (jqlessPathDir) return jqlessPathDir;
  const dir = mkdtempSync(join(tmpdir(), 'rbr-nojq-'));
  const linked = new Set<string>();
  for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'jq' || linked.has(name)) continue;
      try {
        symlinkSync(join(d, name), join(dir, name));
        linked.add(name);
      } catch {
        /* first-wins across dirs; skip collisions and unreadable entries */
      }
    }
  }
  jqlessPathDir = dir;
  return dir;
}

function runBash(script: string, hideJq: boolean): string {
  const env = { ...process.env };
  if (hideJq) {
    env.PATH = buildJqlessPath();
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
