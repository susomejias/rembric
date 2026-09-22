import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SYMBOLS = [
  'findRedundancyCandidates',
  'findDriftCandidates',
  'findContradictionCandidates',
  'judgeDecisionSchema',
  'ConsolidationScheduler',
  'croner',
  'applyMerge',
  'applySupersede',
  'recordNoop',
  'recordFailed',
] as const;

const FORBIDDEN_SRC_WIDE = ['LlmClient'] as const;

const here = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('9.13 — legacy consolidator detectors stay deleted', () => {
  const files = listSourceFiles(here);

  for (const symbol of FORBIDDEN_SYMBOLS) {
    it(`'${symbol}' must not appear in any consolidation/*.ts file`, () => {
      const offenders: { file: string; line: number; text: string }[] = [];
      const pattern = new RegExp(`\\b${symbol}\\b`);
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }
          if (pattern.test(line)) {
            offenders.push({ file, line: i + 1, text: trimmed });
          }
        }
      }
      if (offenders.length > 0) {
        const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
        throw new Error(
          `Legacy detector '${symbol}' was reintroduced. The v0.1 LLM-driven detection ` +
            `is deleted; use save-time candidate detection + memory.judge instead.\n${formatted}`,
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe('the llm/ directory stays deleted', () => {
  const srcRoot = join(here, '..');
  const files = listSourceFiles(srcRoot);

  for (const symbol of FORBIDDEN_SRC_WIDE) {
    it(`'${symbol}' must not appear anywhere under src/`, () => {
      const offenders: { file: string; line: number; text: string }[] = [];
      const pattern = new RegExp(`\\b${symbol}\\b`);
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }
          if (pattern.test(line)) {
            offenders.push({ file, line: i + 1, text: trimmed });
          }
        }
      }
      if (offenders.length > 0) {
        const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
        throw new Error(
          `'${symbol}' was reintroduced. Embeddings are in-process ` +
            `(src/embeddings/); there is no HTTP LLM client.\n${formatted}`,
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});
