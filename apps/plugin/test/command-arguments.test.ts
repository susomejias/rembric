import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contextSchema,
  memorySaveSchema,
  memorySearchSchema,
} from '../../server/src/mcp/memory-tools.js';
import { sessionSummarySchema } from '../../server/src/mcp/session-tools.js';

/**
 * Command bodies are agent-facing instructions: the model reads one and issues
 * the call verbatim, so a parameter the tool's schema does not accept is a
 * runtime zod rejection. `memory.search({q})`, `memory.context({limit})` and
 * `memory.session_summary({auto})` all reached a published spec this way.
 */

const SCHEMAS: Record<string, Record<string, unknown>> = {
  save: memorySaveSchema,
  search: memorySearchSchema,
  context: contextSchema,
  session_summary: sessionSummarySchema,
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

/**
 * Pinned per command, so a DROPPED argument fails too. Asserting only that
 * every named key is accepted leaves `memory.session_summary({})` passing.
 */
const EXPECTED: Record<string, { tool: string; keys: string[] }[]> = {
  'context.md': [{ tool: 'save', keys: ['topic_key'] }],
  'recall.md': [{ tool: 'search', keys: ['query', 'limit'] }],
  'remember.md': [{ tool: 'save', keys: ['type', 'title', 'content'] }],
  'summary.md': [{ tool: 'session_summary', keys: ['title', 'summary'] }],
};

function callSites(body: string): { tool: string; keys: string[] }[] {
  return [...body.matchAll(/memory\.([a-z_]+)\(\{([^{}]*)\}\)/g)].map((m) => ({
    tool: m[1]!,
    keys: m[2]!
      .split(',')
      .map((entry) => entry.split(':')[0]!.trim())
      .filter(Boolean),
  }));
}

/**
 * Calls passing an object literal, counted without parsing it. A call the
 * pattern cannot parse — a nested object in an argument — is simply absent from
 * `callSites`, and an absent site still satisfies the pinned array, so the
 * schema check silently never runs on it. Argument-less calls
 * (`memory.context()`) are deliberately not counted: there is nothing to check.
 */
function objectCallCount(body: string): number {
  return [...body.matchAll(/memory\.[a-z_]+\(\s*\{/g)].length;
}

describe('command bodies name only arguments their tool accepts', () => {
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
