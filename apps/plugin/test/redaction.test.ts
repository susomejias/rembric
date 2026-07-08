import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Fixture = { name: string; input: string; expected: string };

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, 'redaction-fixtures.json'), 'utf8'),
) as Fixture[];
const transcriptSh = join(here, '..', 'scripts', '_transcript.sh');
const hermesInit = join(here, '..', '.hermes-plugin', '__init__.py');

function bashRedact(input: string): string {
  return execFileSync(
    'bash',
    ['-c', 'source "$0" && rembric_redact_private "$1"', transcriptSh, input],
    {
      encoding: 'utf8',
    },
  );
}

const hasPython3 = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function pythonRedact(input: string): string {
  const program = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('rembric_hermes_plugin', sys.argv[1])",
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'sys.stdout.write(mod._redact_private(sys.stdin.read()))',
  ].join('\n');
  return execFileSync('python3', ['-c', program, hermesInit], { input, encoding: 'utf8' });
}

describe('rembric_redact_private (bash, scripts/_transcript.sh)', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(bashRedact(fixture.input)).toBe(fixture.expected);
    });
  }

  it('is applied by the transcript and title choke points before upload text is emitted', () => {
    const src = readFileSync(transcriptSh, 'utf8');
    expect(src).toContain('out="$(rembric_redact_private "$out")"');
    expect(src).toContain('title="$(rembric_redact_private "$title")"');
  });

  it('redacts through the public transcript formatter (jq or awk path)', () => {
    const jsonl =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'use <private>postgres://u:p@h/db</private> now' },
      }) + '\n';
    const out = execFileSync(
      'bash',
      [
        '-c',
        'tmp="$(mktemp)" && printf %s "$1" > "$tmp" && source "$0" && rembric_format_transcript_claude_code "$tmp"; rm -f "$tmp"',
        transcriptSh,
        jsonl,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('postgres://u:p@h/db');
  });
});

describe.runIf(hasPython3)('_redact_private (python, .hermes-plugin/__init__.py)', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(pythonRedact(fixture.input)).toBe(fixture.expected);
    });
  }
});
