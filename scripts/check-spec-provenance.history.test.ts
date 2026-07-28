import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  affectedCapabilities,
  checkProvenance,
  gitDiffEntries,
  hasArchiveArrival,
  pairedCapabilities,
} from './check-spec-provenance.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

/**
 * Replays real history, so it needs a full clone. The main `test` job checks out
 * at depth 1 and this failed there with `fatal: bad revision` — the measurement
 * that is this gate's central evidence could not run in CI. It runs in the
 * `spec-provenance` job instead, which already pays for `fetch-depth: 0`, and is
 * excluded from the default vitest include so it cannot silently skip.
 */

const WINDOW_START = '77cbc2f';
const WINDOW_END = '1814f7b';

// The eight commits in WINDOW_START..WINDOW_END (inclusive, 40 commits touching
// openspec/specs/) that changed a published spec with no archive folder arriving
// in the same diff. Measured, not asserted from the proposal.
const DIFF_LEVEL_VIOLATIONS = [
  '1814f7b',
  '48b7c58',
  'b14368d',
  'ef4ac49',
  '33c5ece',
  '11e0b78',
  '45fe9f0',
  'f320036',
];

// 3baff49 archived add-entity-index (deltas for dashboard, mcp-api,
// memory-entities, persistence) while also editing openspec/specs/memory/spec.md,
// which had no delta — the per-capability rule's ninth true positive.
const CAPABILITY_VIOLATIONS = [...DIFF_LEVEL_VIOLATIONS, '3baff49'];

const RECENT_CASES = [
  { sha: '1b41583', diffLevel: 'fail', capabilities: ['development-environment'] },
  { sha: '82d672e', diffLevel: 'pass', capabilities: ['plugin-session-protocol'] },
  { sha: '878171b', diffLevel: 'pass', capabilities: [] },
];

function reachable(...shas: string[]): boolean {
  return shas.every((sha) => {
    const run = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT });
    return run.status === 0;
  });
}

function verdict(sha: string) {
  const entries = gitDiffEntries(`${sha}~1`, sha, REPO_ROOT);
  const message = execFileSync('git', ['log', '--format=%B', '-1', sha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    entries,
    capability: checkProvenance(entries, { trailers: [message] }),
    diffLevelOk: affectedCapabilities(entries).length === 0 || hasArchiveArrival(entries),
  };
}

const historyAvailable = reachable(
  `${WINDOW_START}~1`,
  WINDOW_END,
  ...RECENT_CASES.map((c) => c.sha),
);

// `skipIf` suppresses the tests but NOT the describe callback, which vitest runs
// at collection — so a `git log` here executed even when skipped, and that is what
// failed CI on a depth-1 checkout with `fatal: bad revision`. Resolved lazily.
let cachedWindow: string[] | null = null;
function commitWindow(): string[] {
  cachedWindow ??= execFileSync(
    'git',
    ['log', '--format=%H', `${WINDOW_START}~1..${WINDOW_END}`, '--', 'openspec/specs/'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((sha) => sha.slice(0, 7));
  return cachedWindow;
}

describe.skipIf(!historyAvailable)('history replay', () => {
  it('covers the 40-commit measurement window', () => {
    expect(commitWindow()).toHaveLength(40);
    expect(new Set(commitWindow()).size).toBe(40);
    for (const sha of CAPABILITY_VIOLATIONS) expect(commitWindow()).toContain(sha);
  });

  it('the diff-level rule flags exactly the eight measured commits', () => {
    const flagged = commitWindow().filter((sha) => !verdict(sha).diffLevelOk);
    expect(flagged.sort()).toEqual([...DIFF_LEVEL_VIOLATIONS].sort());
    expect(commitWindow().length - flagged.length).toBe(32);
  });

  it('the per-capability rule flags exactly nine, and passes the other 31', () => {
    const flagged = commitWindow().filter((sha) => !verdict(sha).capability.ok);
    expect(flagged.sort()).toEqual([...CAPABILITY_VIOLATIONS].sort());
    expect(commitWindow().length - flagged.length).toBe(31);
  });

  it('attributes both capabilities on the multi-capability violation', () => {
    expect(verdict('b14368d').capability.violations.map((v) => v.capability)).toEqual([
      'mcp-api',
      'plugin-session-protocol',
    ]);
  });

  it('attributes the unpaired capability on the archive-plus-hand-edit violation', () => {
    const { capability, diffLevelOk } = verdict('3baff49');
    expect(diffLevelOk).toBe(true);
    expect(capability.violations.map((v) => v.capability)).toEqual(['memory']);
  });

  it('passes the archive commit that paired all eight of its capabilities', () => {
    const { entries, capability } = verdict('02b3a7c');
    expect(affectedCapabilities(entries)).toHaveLength(8);
    expect(pairedCapabilities(entries)).toEqual(
      expect.arrayContaining(affectedCapabilities(entries)),
    );
    expect(capability.ok).toBe(true);
  });

  it.each(RECENT_CASES)('$sha', ({ sha, diffLevel, capabilities }) => {
    const { capability, diffLevelOk } = verdict(sha);
    expect(diffLevelOk).toBe(diffLevel === 'pass');
    expect(capability.violations.map((v) => v.capability)).toEqual(capabilities);
  });
});
