import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SupplyChainSources } from './supply-chain-inventory.js';
import {
  findSupplyChainViolations,
  parseAllowBuilds,
  readSupplyChainSources,
} from './supply-chain-inventory.js';

const real = readSupplyChainSources(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
);

describe('parseAllowBuilds', () => {
  it('parses a well-formed block', () => {
    expect(
      parseAllowBuilds(
        [
          'packages:',
          "  - 'apps/*'",
          'allowBuilds:',
          '  husky: true # hooks',
          '  esbuild: false # deny',
        ].join('\n'),
      ),
    ).toEqual([
      { name: 'husky', allowed: true, justification: 'hooks' },
      { name: 'esbuild', allowed: false, justification: 'deny' },
    ]);
  });

  it('stops at the next top-level key, tolerating blank and comment lines inside the block', () => {
    const entries = parseAllowBuilds(
      [
        'allowBuilds:',
        '  husky: true # hooks',
        '',
        '  # a note about the next entry',
        '  esbuild: false # deny',
        '',
        '# a note about the next key',
        'blockExoticSubdeps: true',
        '  husky: false # must never be read',
      ].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['husky', 'esbuild']);
  });

  it('parses an entry with no comment, leaving the justification empty for the assertions to catch', () => {
    expect(parseAllowBuilds(['allowBuilds:', '  husky: true'].join('\n'))).toEqual([
      { name: 'husky', allowed: true, justification: '' },
    ]);
  });

  it('throws on an entry whose comment is a bare `#`, quoting the line', () => {
    expect(() => parseAllowBuilds(['allowBuilds:', '  husky: true #'].join('\n'))).toThrow(
      /unclassifiable line 2: " {2}husky: true #"/,
    );
  });

  it('throws on a nested or quoted entry, quoting the line', () => {
    expect(() =>
      parseAllowBuilds(['allowBuilds:', '  nested:', '    husky: true # hooks'].join('\n')),
    ).toThrow(/unclassifiable line 2: " {2}nested:"/);
    expect(() => parseAllowBuilds(['allowBuilds:', "  'husky': true # hooks"].join('\n'))).toThrow(
      /unclassifiable line 2/,
    );
  });

  it('throws on a non-boolean value, quoting the line', () => {
    expect(() => parseAllowBuilds(['allowBuilds:', '  husky: yes # hooks'].join('\n'))).toThrow(
      /unclassifiable line 2: " {2}husky: yes # hooks"/,
    );
  });

  it('throws when the block is absent, naming the retired pnpm 10 key', () => {
    expect(() => parseAllowBuilds('onlyBuiltDependencies:\n  - husky\n')).toThrow(
      /onlyBuiltDependencies/,
    );
  });

  it('tolerates CRLF rather than blaming a key rename that never happened', () => {
    expect(parseAllowBuilds('allowBuilds:\r\n  husky: true # hooks\r\n')).toEqual([
      { name: 'husky', allowed: true, justification: 'hooks' },
    ]);
  });

  it('accepts an inline comment on the block header', () => {
    expect(parseAllowBuilds('allowBuilds: # the whole surface\n  husky: true # hooks\n')).toEqual([
      { name: 'husky', allowed: true, justification: 'hooks' },
    ]);
  });

  it('throws with its own diagnosis on YAML flow style, which pnpm honours but this cannot read', () => {
    expect(() => parseAllowBuilds('allowBuilds: { husky: true }\n')).toThrow(/flow style/);
  });
});

/**
 * A gate never observed to fail is not a gate. Each case mutates an in-memory
 * copy of the real files — never the tree — and asserts the violation names the
 * offender. The unmutated positive direction belongs to `invariants.test.ts`.
 */
describe('findSupplyChainViolations fires on each way the surface can drift', () => {
  const violationsWith = (over: Partial<SupplyChainSources>) =>
    findSupplyChainViolations({ ...real, ...over }).join('\n');

  /** Replaces husky's whole line. Throws rather than silently no-op if it stops matching. */
  const grant = (line: string) => {
    const mutated = real.workspace.replace(/^ {2}husky: true.*$/m, line);
    if (mutated === real.workspace)
      throw new Error('grant() matched nothing; the fixture is stale');
    return mutated;
  };

  it('an unpinned `true` entry names the package and the governance requirement', () => {
    expect(
      violationsWith({
        workspace: grant('  husky: true # hooks\n  vite: true # not pinned'),
        lockfile: `${real.lockfile}\n  vite@7.0.0:\n`,
      }),
    ).toMatch(/vite[\s\S]*supply-chain-hygiene/);
  });

  it('a pin whose grant has been removed names the stale pin', () => {
    expect(violationsWith({ workspace: grant('  husky: false # revoked') })).toMatch(/pins husky/);
  });

  it('a `true` entry with no justification comment names the package', () => {
    expect(violationsWith({ workspace: grant('  husky: true') })).toMatch(
      /no trailing justification comment: husky/,
    );
  });

  it('a grant that no longer resolves in the lockfile names the dead entry', () => {
    expect(
      violationsWith({ lockfile: real.lockfile.replace(/^ {2}husky@/gm, '  husky-fork@') }),
    ).toMatch(/grants husky, which no longer resolve/);
  });

  it('renaming the block to the retired key throws, because nothing parses', () => {
    expect(() =>
      violationsWith({
        workspace: real.workspace.replace('allowBuilds:', 'onlyBuiltDependencies:'),
      }),
    ).toThrow(/onlyBuiltDependencies/);
  });

  it('declaring the retired key ALONGSIDE allowBuilds is reported, not silently tolerated', () => {
    expect(
      violationsWith({
        workspace: `onlyBuiltDependencies:\n  - husky\n${real.workspace}`,
      }),
    ).toMatch(/declares the retired pnpm 10 key/);
  });

  it('a malformed in-block line throws rather than being skipped', () => {
    expect(() =>
      violationsWith({ workspace: grant('  husky: true # hooks\n  "sqlite-vec": true # quoted') }),
    ).toThrow(/unclassifiable line/);
  });

  it('losing `ignore-scripts=true` is a violation, and the message names the effective value', () => {
    expect(
      violationsWith({ npmrc: real.npmrc.replace('ignore-scripts=true', 'ignore-scripts=false') }),
    ).toMatch(/ignore-scripts=true \(effective value: false\)/);
  });

  it('ini is last-wins, so a later override is what counts', () => {
    expect(violationsWith({ npmrc: `${real.npmrc}\nignore-scripts=false\n` })).toMatch(
      /effective value: false/,
    );
    expect(violationsWith({ npmrc: `ignore-scripts=false\n${real.npmrc}` })).not.toMatch(
      /ignore-scripts/,
    );
  });

  it('`dangerouslyAllowAllBuilds: true` is reported — it is the one real bypass', () => {
    for (const workspace of [
      `dangerouslyAllowAllBuilds: true\n${real.workspace}`,
      `${real.workspace}\ndangerouslyAllowAllBuilds: true\n`,
    ]) {
      expect(violationsWith({ workspace })).toMatch(/dangerouslyAllowAllBuilds: true/);
    }
  });

  it('the bypass flag on an install line is reported', () => {
    for (const flag of [
      '--dangerously-allow-all-builds',
      '--config.dangerouslyAllowAllBuilds=true',
    ]) {
      expect(
        violationsWith({
          dockerfile: real.dockerfile.replace(
            'pnpm install --frozen-lockfile',
            `pnpm install ${flag} --frozen-lockfile`,
          ),
        }),
      ).toMatch(/dangerously-allow-all-builds flag/);
    }
  });

  it('a COPY that lands AFTER the install does not count — order is checked, not presence', () => {
    const moved = real.dockerfile
      .replace(
        /^COPY package\.json pnpm-lock\.yaml \.npmrc pnpm-workspace\.yaml \.\/$/m,
        'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
      )
      .replace(
        /^(RUN pnpm install --frozen-lockfile --filter @rembric\/server\.\.\.)$/m,
        '$1\nCOPY .npmrc ./',
      );
    expect(moved).not.toBe(real.dockerfile);
    expect(moved).toMatch(/^COPY \.npmrc \.\/$/m);
    expect(violationsWith({ dockerfile: moved })).toMatch(
      /stage 'builder' runs `pnpm install` without COPYing \.npmrc/,
    );
  });

  it('a commented-out install does not satisfy the vacuity guard', () => {
    expect(
      violationsWith({
        dockerfile: real.dockerfile.replace(
          /^RUN pnpm install/gm,
          '# this used to be RUN pnpm install',
        ),
      }),
    ).toMatch(/no stage runs `pnpm install`/);
  });

  it('a `\\`-continued COPY is one instruction and must not read as missing', () => {
    const split = real.dockerfile.replace(
      /^COPY package\.json pnpm-lock\.yaml \.npmrc pnpm-workspace\.yaml \.\/$/m,
      'COPY package.json pnpm-lock.yaml \\\n    .npmrc pnpm-workspace.yaml ./',
    );
    expect(split).not.toBe(real.dockerfile);
    expect(violationsWith({ dockerfile: split })).not.toMatch(/without COPYing/);
  });

  it('an empty allowBuilds block cannot pass any set comparison vacuously', () => {
    expect(violationsWith({ workspace: 'allowBuilds:\nblockExoticSubdeps: true\n' })).toMatch(
      /zero `true` entries/,
    );
  });

  it('an image stage that installs without COPYing .npmrc names the stage', () => {
    expect(
      violationsWith({ dockerfile: real.dockerfile.replace(/^COPY\b.*\.npmrc.*$/m, 'COPY . ./') }),
    ).toMatch(/stage 'builder' runs `pnpm install` without COPYing \.npmrc/);
  });

  it('a Dockerfile that no longer installs at all is reported rather than passing vacuously', () => {
    expect(violationsWith({ dockerfile: 'FROM scratch AS runtime\n' })).toMatch(
      /no stage runs `pnpm install`/,
    );
  });

  it('`pnpm rebuild` naming an unpinned package is reported — explicit args bypass allowBuilds', () => {
    expect(
      violationsWith({
        dockerfile: real.dockerfile.replace(
          'pnpm rebuild better-sqlite3',
          'pnpm rebuild node-gyp-evil better-sqlite3',
        ),
      }),
    ).toMatch(/`pnpm rebuild` for node-gyp-evil, which ALLOWED_BUILD_SCRIPTS does not pin/);
  });

  it('a bare `pnpm rebuild` with no arguments is reported rather than read as granting nothing', () => {
    expect(
      violationsWith({
        dockerfile: real.dockerfile.replace(
          /pnpm rebuild better-sqlite3 sqlite-vec onnxruntime-node/,
          'pnpm rebuild',
        ),
      }),
    ).toMatch(/`pnpm rebuild` with no package arguments/);
  });
});
