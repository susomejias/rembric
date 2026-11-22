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

describe('plugin release ref promotion', () => {
  const promote = (): string => jobBlock('promote-plugin-release');

  it('runs after publish-npm, for a created plugin release or a dispatched tag only', () => {
    const job = promote();
    expect(job).toMatch(/\n {4}needs: \[release-please, publish-npm\]\n/);
    expect(job).toContain("needs.release-please.outputs.plugin_release_created == 'true'");
    expect(job).toContain("needs.publish-npm.result == 'success'");
    expect(job).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.plugin_release_tag != ''",
    );
    expect(jobBlock('release-please')).toContain(
      "plugin_tag_name: ${{ steps.release.outputs['apps/plugin--tag_name'] }}",
    );
    expect(workflow).toMatch(/\n {6}plugin_release_tag:\n {8}description: .+\n {8}type: string\n/);
  });

  it('keeps GITHUB_TOKEN read-only and writes only with a SHA-pinned App token', () => {
    const job = promote();
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}[a-z]/);
    expect(job).not.toMatch(/^ +contents: write$/m);
    expect(job).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(job).toContain('client-id: ${{ vars.PLUGIN_RELEASE_APP_CLIENT_ID }}');
    expect(job).toContain('private-key: ${{ secrets.PLUGIN_RELEASE_APP_PRIVATE_KEY }}');
    expect(job).toContain('permission-contents: write');
    expect(job).toContain('GH_TOKEN: ${{ steps.app-token.outputs.token }}');
  });

  it('queues in its own group like the publish jobs', () => {
    expect(promote()).toMatch(queuedGroup('promote-plugin-release'));
  });

  it('never interpolates workflow inputs or outputs into a shell script', () => {
    const runs = [...promote().matchAll(/\n {8}run: \|\n((?: {10}.*\n|\n)+)/g)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThan(0);
    for (const script of runs) expect(script).not.toContain('${{');
  });

  it('refuses a target whose bridge is not on npm, is a no-op when already promoted, and forces only on dispatch', () => {
    const job = promote();
    expect(job).toContain('apps/plugin/mcp-bridge/package.json');
    expect(job).toContain('registry.npmjs.org/@rembric%2fmcp-bridge/');
    expect(job).toContain("if: steps.resolve.outputs.move == 'true'");
    expect(job).toContain(
      "FORCE: ${{ github.event_name == 'workflow_dispatch' && inputs.plugin_release_tag != '' }}",
    );
    expect(job).toMatch(/gh api -X PATCH "repos\/\$REPO\/git\/refs\/heads\/plugin-release"/);
  });
});
