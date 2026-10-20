import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contextSchema,
  memoryConfirmSchema,
  memorySaveSchema,
  memorySearchSchema,
} from '../../../packages/mcp/src/memory-tools.js';
import { judgeSchema } from '../../../packages/mcp/src/relations-tools.js';
import { sessionGetSchema, sessionSummarySchema } from '../../../packages/mcp/src/session-tools.js';

const SCHEMAS: Record<string, Record<string, unknown>> = {
  save: memorySaveSchema,
  search: memorySearchSchema,
  context: contextSchema,
  session_summary: sessionSummarySchema,
  session_get_batch: sessionGetSchema,
  confirm_batch: memoryConfirmSchema,
  judge_batch: judgeSchema,
};

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(here, '..', 'commands');
const commandFiles = readdirSync(commandsDir)
  .filter((name) => name.endsWith('.md'))
  .sort();

function parse(file: string): { name: string; description: string; body: string } {
  const raw = readFileSync(join(commandsDir, file), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: no frontmatter block`);
  const description = match[1].match(/^description:[ \t]*(.*)$/m)?.[1];
  if (description === undefined) throw new Error(`${file}: no description in frontmatter`);
  return { name: file.replace(/\.md$/, ''), description, body: match[2] };
}

const EXPECTED: Record<string, { tool: string; keys: string[] }[]> = {
  'context.md': [
    { tool: 'confirm_batch', keys: ['ids'] },
    { tool: 'save', keys: ['topic_key'] },
    { tool: 'judge_batch', keys: ['judgments'] },
    { tool: 'session_get_batch', keys: ['from', 'to', 'limit', 'offset'] },
  ],
  'recall.md': [{ tool: 'search', keys: ['query', 'limit'] }],
  'remember.md': [{ tool: 'save', keys: ['type', 'title', 'content', 'tags'] }],
  'summary.md': [{ tool: 'session_summary', keys: ['title', 'summary'] }],
};

function callSites(body: string): { tool: string; keys: string[] }[] {
  return [...body.matchAll(/memory\.([a-z_]+)\(\{(.*?)\}\)/g)].map((m) => ({
    tool: m[1]!,
    keys: m[2]!
      .replace(/\[[^\]]*\]/g, '')
      .split(',')
      .map((entry) => entry.split(':')[0]!.trim())
      .filter(Boolean),
  }));
}

function objectCallCount(body: string): number {
  return [...body.matchAll(/memory\.[a-z_]+\(\s*\{/g)].length;
}

describe('command bodies name only arguments their tool accepts', () => {
  it('parses array arguments without mistaking nested fields for tool arguments', () => {
    expect(
      callSites(
        'memory.judge_batch({ judgments: [{ judgmentId, relation: "related" }, { judgmentId, relation: "compatible" }] })',
      ),
    ).toEqual([{ tool: 'judge_batch', keys: ['judgments'] }]);
    expect(callSites('memory.confirm_batch({ ids: [first, second], verdict: "affirm" })')).toEqual([
      { tool: 'confirm_batch', keys: ['ids', 'verdict'] },
    ]);
  });

  it('remember derives required reusable tags without another call', () => {
    const body = parse('remember.md').body;
    expect(body).toContain('1–64');
    expect(body).toContain('normally 1–5 useful reusable lowercase Unicode kebab-case');
    expect(body).toContain('derived from the text');
    for (const example of ['dashboard', 'sqlite', 'bug-fix']) expect(body).toContain(example);
    expect(objectCallCount(body)).toBe(1);
  });

  it('ships exactly four commands', () => {
    expect(commandFiles).toEqual(Object.keys(EXPECTED));
  });

  it.each(commandFiles)('%s calls exactly what it is pinned to', (file) => {
    const body = parse(file).body;
    expect(callSites(body)).toEqual(EXPECTED[file]);
    expect(objectCallCount(body), `${file}: a memory.* call was not parsed`).toBe(
      EXPECTED[file]!.length,
    );
  });

  it.each(commandFiles)('%s names only arguments its tool accepts', (file) => {
    for (const { tool, keys } of EXPECTED[file]!) {
      const schema = SCHEMAS[tool];
      // An unmapped tool is a failure, not a skip.
      expect(schema, `memory.${tool} has no schema in SCHEMAS`).toBeDefined();
      for (const key of keys) {
        expect(Object.keys(schema!), `${file}: memory.${tool} argument "${key}"`).toContain(key);
      }
    }
  });
});

describe('command frontmatter budgets', () => {
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

  it.each(commandFiles)('%s description ≤80 bytes (20 tokens)', (file) => {
    expect(bytes(parse(file).description)).toBeLessThanOrEqual(80);
  });

  it.each(commandFiles)('%s body stays within its line budget', (file) => {
    const lines = parse(file)
      .body.split('\n')
      .filter((l) => l.trim().length > 0);
    const maxLines = file === 'summary.md' ? 7 : 3;
    expect(lines.length).toBeLessThanOrEqual(maxLines);
  });

  it('the four always-on listings total ≤320 bytes (80 tokens)', () => {
    // The listing string is what a client renders per command: "/rembric:<name> <description>".
    const total = commandFiles.reduce((sum, file) => {
      const { name, description } = parse(file);
      return sum + bytes(`/rembric:${name} ${description}`);
    }, 0);
    expect(total).toBeLessThanOrEqual(320);
  });
});
