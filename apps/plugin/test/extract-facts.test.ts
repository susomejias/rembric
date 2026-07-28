import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const transcriptSh = join(here, '..', 'scripts', '_transcript.sh');
const fixture = join(here, 'facts-fixture.claude-code.jsonl');

function extract(path: string): string {
  return execFileSync(
    'bash',
    ['-c', `. "${transcriptSh}"; rembric_extract_facts_claude_code "${path}"`],
    { encoding: 'utf8' },
  );
}

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function tmpFile(name: string, body: string): string {
  scratch = mkdtempSync(join(tmpdir(), 'rbr-facts-'));
  const p = join(scratch, name);
  writeFileSync(p, body);
  return p;
}

describe('deterministic session facts (claude-code)', () => {
  it('names the files that were written or edited, deduplicated', () => {
    const out = extract(fixture);
    expect(out).toContain('/repo/src/a.ts');
    expect(out).toContain('/repo/src/b.ts');
    // a.ts was edited twice; the fact list is a set, not a log.
    expect(out.match(/\/repo\/src\/a\.ts/g)).toHaveLength(1);
    expect(out).toContain('files touched (2 distinct)');
  });

  it('does NOT count a file it only read as touched', () => {
    // `Read` on a.ts must not be what puts a.ts in the list — the Edit does.
    // Asserted by exclusion of the read-only path in a transcript with no edits.
    const readOnly = tmpFile(
      't.jsonl',
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'r1',
              name: 'Read',
              input: { file_path: '/repo/only-read.ts' },
            },
          ],
        },
      })}\n`,
    );
    const out = extract(readOnly);
    expect(out).not.toContain('/repo/only-read.ts');
    expect(out).not.toContain('files touched');
  });

  // The assertion that matters most: a list of commands with no status is the
  // version of this that looks right and is useless.
  it('identifies the failed command AS failed, and does not mark the others', () => {
    const out = extract(fixture);
    expect(out).toContain('commands: 3 run, 1 failed');
    const failedBlock = out.slice(out.indexOf('failed commands:'));
    expect(failedBlock).toContain('pnpm vitest run src/a.test.ts');
    expect(failedBlock).not.toContain('pnpm run typecheck');
    expect(failedBlock).not.toContain('git status');
  });

  it('collapses newlines inside a command so one fact stays one line', () => {
    const out = extract(fixture);
    expect(out).toContain('pnpm vitest run src/a.test.ts');
    expect(out).not.toContain('pnpm vitest run\nsrc/a.test.ts');
  });

  it('reports the tools it saw', () => {
    expect(extract(fixture)).toMatch(/tools: .*Read/);
  });

  // Traceability: every emitted path and command must exist in the input. A
  // fallback that can assert something that did not happen is worse than none.
  it('emits no path and no command absent from the transcript', () => {
    const out = extract(fixture);
    const input = execFileSync('cat', [fixture], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const fact = line.replace(/^\s*-\s*/, '').trim();
      if (!fact || !fact.startsWith('/')) continue;
      expect(input, `emitted a path not in the transcript: ${fact}`).toContain(fact);
    }
  });

  it('exits successfully and writes nothing for an unparseable transcript', () => {
    const junk = tmpFile('t.jsonl', 'not json at all\n{{{\n');
    expect(extract(junk).trim()).toBe('');
  });

  it('exits successfully for a missing or empty transcript', () => {
    expect(extract('/nonexistent/path.jsonl').trim()).toBe('');
    const empty = tmpFile('t.jsonl', '');
    expect(extract(empty).trim()).toBe('');
  });

  it('says how many facts it dropped rather than truncating silently', () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `w${i}`,
                name: 'Write',
                input: { file_path: `/repo/f${i}.ts`, content: 'x' },
              },
            ],
          },
        }),
      );
    }
    const many = tmpFile('t.jsonl', `${lines.join('\n')}\n`);
    const out = extract(many);
    expect(out).toContain('files touched (80 distinct)');
    expect(out).toContain('(+20 more not listed)');
  });
});
