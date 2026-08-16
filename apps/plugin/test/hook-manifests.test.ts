import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Exact-set assertions, never `toContain`: a containment check cannot catch a
 * spec claiming an event type is *absent*, which is the defect these guard.
 * Event-type and handler counts are both asserted because Codex's per-hook
 * trust prompt counts handlers while its docs count event types.
 */

type HookHandler = { type: string; command: string; async?: boolean; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type HookManifest = { hooks: Record<string, HookGroup[]> };

const here = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(...segments: string[]): T =>
  JSON.parse(readFileSync(join(here, '..', ...segments), 'utf8')) as T;

const claudeHooks = readJson<HookManifest>('hooks', 'hooks.json').hooks;
const codexHooks = readJson<HookManifest>('hooks', 'hooks.codex.json').hooks;

const eventTypes = (hooks: Record<string, HookGroup[]>): string[] => Object.keys(hooks).sort();
const handlerCount = (hooks: Record<string, HookGroup[]>): number =>
  Object.values(hooks).reduce(
    (total, groups) => total + groups.reduce((n, group) => n + group.hooks.length, 0),
    0,
  );

describe('hooks.json (Claude Code)', () => {
  it('declares exactly six event types', () => {
    expect(eventTypes(claudeHooks)).toEqual(
      [
        'SessionStart',
        'UserPromptSubmit',
        'SessionEnd',
        'PreCompact',
        'PostCompact',
        'Stop',
      ].sort(),
    );
  });

  it('carries exactly eight handler entries', () => {
    expect(handlerCount(claudeHooks)).toBe(8);
  });

  it('declares no PostToolUse entry', () => {
    expect(claudeHooks.PostToolUse).toBeUndefined();
  });

  // `fork` fires for --fork-session, /fork and /branch from v2.1.214 (before
  // that the same action arrived as `resume`). Omitting it means a forked
  // conversation fires NO hook at all: no row, no nudge, session_id NULL for
  // its whole life. Codex declares no `fork` source, so its manifest keeps
  // three; both sides are pinned so a "consistency" fix cannot give Codex a
  // matcher it never emits.
  it('declares exactly the two literal SessionStart matchers, the registration group including fork', () => {
    expect(claudeHooks.SessionStart.map((group) => group.matcher)).toEqual([
      'startup|resume|clear|fork',
      'compact',
    ]);
  });

  it('registers both UserPromptSubmit entries without a matcher key', () => {
    expect(claudeHooks.UserPromptSubmit).toHaveLength(2);
    for (const group of claudeHooks.UserPromptSubmit) {
      expect(Object.keys(group)).toEqual(['hooks']);
    }
  });

  // Stop carries exactly ONE entry, and it must NOT be async: an async hook
  // is fire-and-forget by the host's contract and could not deliver a
  // response the next turn depends on.
  it('declares exactly one synchronous Stop entry, invoking stop-report.sh', () => {
    const handlers = claudeHooks.Stop.flatMap((group) => group.hooks);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.command).toContain('scripts/stop-report.sh');
    expect(handlers[0]!.async).toBeUndefined();
  });
});

describe('hooks.codex.json (Codex CLI)', () => {
  it('declares exactly six event types', () => {
    expect(eventTypes(codexHooks)).toEqual(
      [
        'SessionStart',
        'UserPromptSubmit',
        'Stop',
        'PreCompact',
        'PostCompact',
        'SessionEnd',
      ].sort(),
    );
  });

  it('carries exactly eight handler entries', () => {
    expect(handlerCount(codexHooks)).toBe(8);
  });

  it('declares no PostToolUse entry', () => {
    expect(codexHooks.PostToolUse).toBeUndefined();
  });

  // `matcher` filters SessionEnd's `reason`, whose only current value is
  // `other`, so declaring one would only ever narrow the event to nothing.
  it('declares a matcher-less SessionEnd entry', () => {
    expect(codexHooks.SessionEnd).toHaveLength(1);
    expect(Object.keys(codexHooks.SessionEnd[0])).toEqual(['hooks']);
    expect(codexHooks.SessionEnd[0].hooks).toHaveLength(1);
  });

  // Codex allows SessionEnd 1 second by default and 3 at most, against 600 for
  // every other hook. The declared maximum alone still lets one hanging request
  // eat the whole budget, so the POST is separately capped below it — a hanging
  // server then yields the stderr diagnostic instead of a handler killed with
  // no record. Both halves are asserted, plus the control that 3 is the ceiling.
  it('fits the SessionEnd handler inside the event budget', () => {
    const entry = codexHooks.SessionEnd[0].hooks[0];
    expect(entry.timeout).toBe(3);
    const postBudget = Number(/REMBRIC_POST_MAX_TIME=(\d+)/.exec(entry.command)?.[1]);
    expect(postBudget).toBeLessThan(entry.timeout as number);
    expect(entry.timeout as number).toBeLessThanOrEqual(3);
  });

  it('declares exactly the two literal SessionStart matchers, without fork', () => {
    expect(codexHooks.SessionStart.map((group) => group.matcher)).toEqual([
      'startup|resume|clear',
      'compact',
    ]);
  });

  it('registers both UserPromptSubmit entries without a matcher key', () => {
    expect(codexHooks.UserPromptSubmit).toHaveLength(2);
    for (const group of codexHooks.UserPromptSubmit) {
      expect(Object.keys(group)).toEqual(['hooks']);
    }
  });
});

describe('plugin manifest identity across clients', () => {
  type PluginManifest = {
    name: string;
    version: string;
    license: string;
    repository: string;
    author: { name: string; url: string };
    keywords: string[];
    commands?: unknown;
    mcpServers?: unknown;
    hooks?: unknown;
  };

  const claude = readJson<PluginManifest>('.claude-plugin', 'plugin.json');
  const codex = readJson<PluginManifest>('.codex-plugin', 'plugin.json');

  it.each(['name', 'version', 'license', 'repository'] as const)(
    '%s is byte-identical in both manifests',
    (field) => {
      expect(codex[field]).toBe(claude[field]);
    },
  );

  it('author.name and author.url are byte-identical in both manifests', () => {
    expect(codex.author).toEqual(claude.author);
  });

  it('keywords are byte-identical in both manifests', () => {
    expect(codex.keywords).toEqual(claude.keywords);
  });

  // The whole key set, not a filter over two names: filtering lets a stray
  // `commands` or `skills` key pass, which is the claim this is meant to pin.
  it('neither manifest declares a commands field — /rembric:* is Claude-Code-only', () => {
    expect(claude.commands).toBeUndefined();
    expect(Object.keys(codex).sort()).toEqual([
      'author',
      'description',
      'homepage',
      'hooks',
      'keywords',
      'license',
      'mcpServers',
      'name',
      'repository',
      'version',
    ]);
  });
});

/**
 * Which script an event invokes, and with which agent argument, was entirely
 * unguarded: pointing Codex's `Stop` at `claude-code` passed the whole suite
 * and would route Codex transcripts through the Claude formatter, yielding
 * empty summaries. Pinned as an ordered list per manifest, and the tail
 * argument matters as much as the script name.
 */
describe('every hook invokes the script the spec names', () => {
  const invocations = (hooks: Record<string, HookGroup[]>): string[] =>
    Object.entries(hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) =>
        g.hooks.map((h) => `${event} ${h.type} ${h.command.replace(/.*scripts\//, 'scripts/')}`),
      ),
    );

  it('hooks.json', () => {
    expect(invocations(claudeHooks)).toEqual([
      'SessionStart command scripts/session-start.sh claude-code',
      'SessionStart command scripts/post-compact.sh claude-code',
      'UserPromptSubmit command scripts/prompt-search.sh',
      'UserPromptSubmit command scripts/prompt-nudge.sh',
      'SessionEnd command scripts/session-end.sh claude-code',
      'PreCompact command scripts/pre-compact.sh claude-code',
      'PostCompact command scripts/post-compaction.sh',
      'Stop command scripts/stop-report.sh claude-code',
    ]);
  });

  it('hooks.codex.json', () => {
    expect(invocations(codexHooks)).toEqual([
      'SessionStart command scripts/session-start.sh codex-cli',
      'SessionStart command scripts/post-compact.sh codex-cli',
      'UserPromptSubmit command scripts/prompt-search.sh',
      'UserPromptSubmit command scripts/prompt-nudge.sh',
      'Stop command scripts/stop-report.sh codex-cli',
      'PreCompact command scripts/pre-compact.sh codex-cli',
      'PostCompact command scripts/post-compaction.sh',
      'SessionEnd command scripts/session-end.sh codex-cli',
    ]);
  });

  // Both manifests wire the same scripts, diverging only through the agent-name
  // argument. A per-client copy is the shape that lets the two drift, so its
  // absence is asserted rather than left to review.
  it('ships no per-client script variant', () => {
    expect(readdirSync(join(here, '..', 'scripts')).filter((f) => f.endsWith('.codex.sh'))).toEqual(
      [],
    );
  });

  it('stop-sync.sh and stop-nudge.sh no longer exist', () => {
    const files = readdirSync(join(here, '..', 'scripts'));
    expect(files).not.toContain('stop-sync.sh');
    expect(files).not.toContain('stop-nudge.sh');
  });

  // An event declaring an empty `hooks` array satisfied both the event-set and
  // the handler-count gates, so moving SessionEnd's handler elsewhere shipped
  // a manifest where sessions never POST /end.
  it.each([
    ['hooks.json', 'claude'],
    ['hooks.codex.json', 'codex'],
  ])('%s declares no empty handler group', (_label, which) => {
    const hooks = which === 'claude' ? claudeHooks : codexHooks;
    for (const [event, groups] of Object.entries(hooks)) {
      expect(groups.length, `${event} has no groups`).toBeGreaterThan(0);
      for (const g of groups) expect(g.hooks.length, `${event} group is empty`).toBeGreaterThan(0);
    }
  });
});
