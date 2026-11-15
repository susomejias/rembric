import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

const commandPrefix = (command: string): string => command.replace(/scripts\/.*$/, '');

describe('hooks.json (Claude Code)', () => {
  it('declares exactly eight event types', () => {
    expect(eventTypes(claudeHooks)).toEqual(
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'SessionEnd',
        'PreCompact',
        'PostCompact',
        'Stop',
        'SubagentStop',
      ].sort(),
    );
  });

  it('carries exactly twelve handler entries', () => {
    expect(handlerCount(claudeHooks)).toBe(12);
  });

  it('declares no PostToolUse entry', () => {
    expect(claudeHooks.PostToolUse).toBeUndefined();
  });

  it('declares exactly the two literal SessionStart matchers, the registration group including fork', () => {
    expect(claudeHooks.SessionStart.map((group) => group.matcher)).toEqual([
      'startup|resume|clear|fork',
      'compact',
    ]);
  });

  it('registers the three UserPromptSubmit entries without a matcher key', () => {
    expect(claudeHooks.UserPromptSubmit).toHaveLength(3);
    for (const group of claudeHooks.UserPromptSubmit) {
      expect(Object.keys(group)).toEqual(['hooks']);
    }
    expect(
      claudeHooks.UserPromptSubmit.map((group) => group.hooks[0].command.split('/').pop()),
    ).toEqual(['prompt-search.sh', 'prompt-nudge.sh', 'prompt-hints.sh']);
  });

  it('declares exactly two PreToolUse entries: file recall, then the SubagentHandback forwarder', () => {
    expect(claudeHooks.PreToolUse.map((group) => group.matcher)).toEqual([
      'Read|Edit|Write|MultiEdit|NotebookEdit|Bash',
      'SubagentHandback',
    ]);
  });

  it('keeps the file-recall PreToolUse entry synchronous on file tools and Bash', () => {
    const group = claudeHooks.PreToolUse[0];
    expect(group!.hooks).toHaveLength(1);
    expect(group!.hooks[0]!.command).toMatch(/scripts\/file-recall\.sh claude-code$/);
    expect(group!.hooks[0]!.async).toBeUndefined();
    expect(group!.hooks[0]!.timeout).toBe(2);
  });

  it('forwards a SubagentHandback report asynchronously with the plugin credentials', () => {
    const group = claudeHooks.PreToolUse[1];
    expect(group!.hooks).toHaveLength(1);
    const [entry] = group!.hooks;
    expect(entry!.type).toBe('command');
    expect(entry!.command).toMatch(/scripts\/subagent-report\.sh claude-code$/);
    expect(entry!.async).toBe(true);
    expect(commandPrefix(entry!.command)).toBe(
      commandPrefix(claudeHooks.PreToolUse[0]!.hooks[0]!.command),
    );
  });

  it('declares one matcher-less asynchronous SubagentStop entry, invoking subagent-report.sh', () => {
    expect(claudeHooks.SubagentStop).toHaveLength(1);
    expect(Object.keys(claudeHooks.SubagentStop[0]!)).toEqual(['hooks']);
    expect(claudeHooks.SubagentStop[0]!.hooks).toHaveLength(1);
    const [entry] = claudeHooks.SubagentStop[0]!.hooks;
    expect(entry!.type).toBe('command');
    expect(entry!.command).toMatch(/scripts\/subagent-report\.sh claude-code$/);
    expect(entry!.async).toBe(true);
    expect(commandPrefix(entry!.command)).toBe(
      commandPrefix(claudeHooks.PreToolUse[0]!.hooks[0]!.command),
    );
  });

  it('declares exactly one synchronous Stop entry, invoking stop-report.sh', () => {
    const handlers = claudeHooks.Stop.flatMap((group) => group.hooks);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.command).toContain('scripts/stop-report.sh');
    expect(handlers[0]!.async).toBeUndefined();
  });
});

describe('hooks.codex.json (Codex CLI)', () => {
  it('declares exactly eight event types', () => {
    expect(eventTypes(codexHooks)).toEqual(
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'Stop',
        'PreCompact',
        'PostCompact',
        'SessionEnd',
        'SubagentStop',
      ].sort(),
    );
  });

  it('carries exactly eleven handler entries', () => {
    expect(handlerCount(codexHooks)).toBe(11);
  });

  it('declares one matcher-less synchronous SubagentStop entry with a 3-second timeout', () => {
    expect(codexHooks.SubagentStop).toHaveLength(1);
    expect(Object.keys(codexHooks.SubagentStop[0]!)).toEqual(['hooks']);
    expect(codexHooks.SubagentStop[0]!.hooks).toHaveLength(1);
    const [entry] = codexHooks.SubagentStop[0]!.hooks;
    expect(entry!.type).toBe('command');
    expect(entry!.command).toBe('"${CLAUDE_PLUGIN_ROOT}"/scripts/subagent-report.sh codex-cli');
    expect(entry!.timeout).toBe(3);
    expect(entry!.async).toBeUndefined();
  });

  it('declares no PostToolUse entry', () => {
    expect(codexHooks.PostToolUse).toBeUndefined();
  });

  it('declares a matcher-less SessionEnd entry', () => {
    expect(codexHooks.SessionEnd).toHaveLength(1);
    expect(Object.keys(codexHooks.SessionEnd[0])).toEqual(['hooks']);
    expect(codexHooks.SessionEnd[0].hooks).toHaveLength(1);
  });

  it('fits the SessionEnd handler inside the event budget', () => {
    const entry = codexHooks.SessionEnd[0].hooks[0];
    expect(entry.timeout).toBe(3);
    const postBudget = Number(/REMBRIC_POST_MAX_TIME=(\d+)/.exec(entry.command)?.[1]);
    expect(postBudget).toBeLessThan(entry.timeout as number);
    expect(entry.timeout as number).toBeLessThanOrEqual(3);
  });

  it('declares one file-recall PreToolUse entry on Bash and apply_patch', () => {
    expect(codexHooks.PreToolUse).toHaveLength(1);
    const [group] = codexHooks.PreToolUse;
    expect(group!.matcher).toBe('Bash|apply_patch');
    expect(group!.hooks).toHaveLength(1);
    expect(group!.hooks[0]!.timeout).toBe(2);
  });

  it('declares exactly the two literal SessionStart matchers, without fork', () => {
    expect(codexHooks.SessionStart.map((group) => group.matcher)).toEqual([
      'startup|resume|clear',
      'compact',
    ]);
  });

  it('registers the three UserPromptSubmit entries without a matcher key', () => {
    expect(codexHooks.UserPromptSubmit).toHaveLength(3);
    for (const group of codexHooks.UserPromptSubmit) {
      expect(Object.keys(group)).toEqual(['hooks']);
    }
    expect(
      codexHooks.UserPromptSubmit.map((group) => group.hooks[0].command.split('/').pop()),
    ).toEqual(['prompt-search.sh', 'prompt-nudge.sh', 'prompt-hints.sh']);
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
      'UserPromptSubmit command scripts/prompt-hints.sh',
      'PreToolUse command scripts/file-recall.sh claude-code',
      'PreToolUse command scripts/subagent-report.sh claude-code',
      'SessionEnd command scripts/session-end.sh claude-code',
      'PreCompact command scripts/pre-compact.sh claude-code',
      'PostCompact command scripts/post-compaction.sh',
      'Stop command scripts/stop-report.sh claude-code',
      'SubagentStop command scripts/subagent-report.sh claude-code',
    ]);
  });

  it('hooks.codex.json', () => {
    expect(invocations(codexHooks)).toEqual([
      'SessionStart command scripts/session-start.sh codex-cli',
      'SessionStart command scripts/post-compact.sh codex-cli',
      'UserPromptSubmit command scripts/prompt-search.sh',
      'UserPromptSubmit command scripts/prompt-nudge.sh',
      'UserPromptSubmit command scripts/prompt-hints.sh',
      'PreToolUse command scripts/file-recall.sh codex-cli',
      'Stop command scripts/stop-report.sh codex-cli',
      'PreCompact command scripts/pre-compact.sh codex-cli',
      'PostCompact command scripts/post-compaction.sh',
      'SessionEnd command scripts/session-end.sh codex-cli',
      'SubagentStop command scripts/subagent-report.sh codex-cli',
    ]);
  });

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
