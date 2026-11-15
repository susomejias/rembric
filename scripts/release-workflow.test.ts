import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const config = JSON.parse(read('release-please-config.json')) as Record<string, unknown>;
const workflow = read('.github/workflows/release-please.yml');

function jobBlock(name: string): string {
  const start = workflow.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  if (start === -1) throw new Error(`job ${name} not found in release-please.yml`);
  const next = workflow.slice(start + 1).search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const serialGroup = (group: string, extra = ''): RegExp =>
  new RegExp(
    `\\n {4}concurrency:\\n {6}group: ${group}-\\$\\{\\{ github\\.ref \\}\\}\\n {6}cancel-in-progress: false\\n${extra}`,
  );

const queuedGroup = (group: string): RegExp => serialGroup(group, ' {6}queue: max\\n');

describe('release-please flow', () => {
  it('rebuilds every open release PR from main on each run, keeping one PR per component', () => {
    expect(config['always-update']).toBe(true);
    expect(config['separate-pull-requests']).toBe(true);
  });

  it('serializes the release-please job, not the whole workflow', () => {
    expect(workflow).not.toMatch(/^concurrency:/m);
    expect(jobBlock('release-please')).toMatch(serialGroup('release-please'));
  });

  it('queues every publish in its own group, so an already-tagged release is never dropped', () => {
    expect(jobBlock('publish-docker')).toMatch(queuedGroup('publish-docker'));
    expect(jobBlock('publish-npm')).toMatch(queuedGroup('publish-npm'));
  });
});
