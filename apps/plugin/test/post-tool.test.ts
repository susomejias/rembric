import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const postToolSh = join(here, '..', 'scripts', 'post-tool.sh');

let counterDir: string;

function runPostTool(stdin: string): string {
  return execFileSync('bash', [postToolSh], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
}

describe('post-tool.sh (throttled save nudge, self-filtering)', () => {
  beforeEach(() => {
    counterDir = mkdtempSync(join(tmpdir(), 'rembric-posttool-'));
  });
  afterEach(() => rmSync(counterDir, { recursive: true, force: true }));

  it('stays silent for a read-only tool', () => {
    const out = runPostTool(JSON.stringify({ tool_name: 'Read', session_id: 's1' }));
    expect(out.trim()).toBe('');
  });

  it('stays silent for the first 7 write-shaped calls, then nudges on the 8th', () => {
    let last = '';
    for (let i = 1; i <= 8; i++) {
      last = runPostTool(JSON.stringify({ tool_name: 'Write', session_id: 's-throttle' }));
      if (i < 8) expect(last.trim()).toBe('');
    }
    const parsed = JSON.parse(last);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('memory.save');
  });

  it('counts each write-shaped tool name toward the throttle', () => {
    let last = '';
    for (const tool of [
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Edit',
      'Write',
      'Edit',
      'Edit',
    ]) {
      last = runPostTool(JSON.stringify({ tool_name: tool, session_id: 's-mixed' }));
    }
    expect(JSON.parse(last).hookSpecificOutput.additionalContext).toContain('memory.save');
  });

  it('recognizes Codex camelCase toolName', () => {
    let last = '';
    for (let i = 1; i <= 8; i++) {
      last = runPostTool(JSON.stringify({ toolName: 'Edit', sessionId: 's-codex' }));
    }
    expect(JSON.parse(last).hookSpecificOutput.additionalContext).toContain('memory.save');
  });

  it('stays silent for an unknown or absent tool name', () => {
    expect(runPostTool(JSON.stringify({ tool_name: 'Grep', session_id: 's2' })).trim()).toBe('');
    expect(runPostTool(JSON.stringify({ session_id: 's3' })).trim()).toBe('');
    expect(runPostTool('').trim()).toBe('');
  });
});
