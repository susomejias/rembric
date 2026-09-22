import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_BUILD_SCRIPTS = [
  'better-sqlite3',
  'husky',
  'onnxruntime-node',
  'sqlite-vec',
] as const;

interface AllowBuildsEntry {
  name: string;
  allowed: boolean;
  justification: string;
}

export interface SupplyChainSources {
  workspace: string;
  lockfile: string;
  npmrc: string;
  dockerfile: string;
}

const BLOCK_START_RE = /^allowBuilds:[ \t]*(?:#.*)?$/;
const FLOW_STYLE_RE = /^allowBuilds:[ \t]*[[{]/m;
const RETIRED_KEY_RE = /^[ \t]*onlyBuiltDependencies[ \t]*:/m;
const BYPASS_KEY_RE = /^[ \t]*dangerouslyAllowAllBuilds[ \t]*:[ \t]*true\b/m;
const ENTRY_RE = /^ {2}([@A-Za-z0-9._/-]+):[ \t]*(true|false)[ \t]*(?:#[ \t]*(\S.*?))?[ \t]*$/;

export function readSupplyChainSources(repoRoot: string): SupplyChainSources {
  return {
    workspace: readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
    lockfile: readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    npmrc: readFileSync(join(repoRoot, '.npmrc'), 'utf8'),
    dockerfile: readFileSync(join(repoRoot, 'apps/web/Dockerfile'), 'utf8'),
  };
}

export function parseAllowBuilds(source: string): AllowBuildsEntry[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (FLOW_STYLE_RE.test(source)) {
    throw new Error(
      'pnpm-workspace.yaml: `allowBuilds` is written in YAML flow style. pnpm honours it, this ' +
        'scanner does not read it, so membership would go unpinned. Use the block form, one entry ' +
        'per line with its justification.',
    );
  }
  const start = lines.findIndex((line) => BLOCK_START_RE.test(line));
  if (start === -1) {
    throw new Error(
      "pnpm-workspace.yaml: no top-level 'allowBuilds:' block found. Without it pnpm denies every " +
        'lifecycle script, so this is not itself unsafe — but membership is then unpinned, and the ' +
        "retired pnpm 10 key 'onlyBuiltDependencies' is ignored silently if that is what replaced it.",
    );
  }

  const entries: AllowBuildsEntry[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^[ \t]*(?:#|$)/.test(line)) continue;
    if (!/^[ \t]/.test(line)) break;

    const match = ENTRY_RE.exec(line);
    if (!match) {
      throw new Error(
        `pnpm-workspace.yaml::allowBuilds: unclassifiable line ${i + 1}: ${JSON.stringify(line)}. ` +
          'Every in-block line must be `  <name>: true|false # <why>`.',
      );
    }
    entries.push({
      name: match[1]!,
      allowed: match[2] === 'true',
      justification: match[3] ?? '',
    });
  }

  return entries;
}

const INVENTORY = 'ALLOWED_BUILD_SCRIPTS';

export function findSupplyChainViolations(sources: SupplyChainSources): string[] {
  const violations: string[] = [];
  const entries = parseAllowBuilds(sources.workspace);
  const granted = entries.filter((e) => e.allowed).map((e) => e.name);

  if (granted.length === 0) {
    violations.push(
      'allowBuilds parsed to zero `true` entries; the pinned inventory would be trivially satisfied.',
    );
  }

  const expected = new Set<string>(ALLOWED_BUILD_SCRIPTS);
  const unpinned = granted.filter((name) => !expected.has(name));
  const stale = [...expected].filter((name) => !granted.includes(name));
  if (unpinned.length > 0) {
    violations.push(
      `allowBuilds grants install-time code execution to ${unpinned.join(', ')}, which ` +
        `${INVENTORY} does not pin. Granting it requires an OpenSpec change against ` +
        `supply-chain-hygiene, then adding the name to ${INVENTORY}.`,
    );
  }
  if (stale.length > 0) {
    violations.push(
      `${INVENTORY} pins ${stale.join(', ')}, which allowBuilds no longer grants. ` +
        'Removing a grant is strengthening, but a pin claiming a grant that does not exist must ' +
        `still be seen: drop the name from ${INVENTORY}.`,
    );
  }

  const undocumented = entries.filter((e) => e.justification === '').map((e) => e.name);
  if (undocumented.length > 0) {
    violations.push(
      `allowBuilds entries carry no trailing justification comment: ${undocumented.join(', ')}. ` +
        'A reader auditing the surface needs why the package runs code at install, at the point ' +
        'of decision.',
    );
  }

  const dead = granted.filter((name) => !resolvesInLockfile(sources.lockfile, name));
  if (dead.length > 0) {
    violations.push(
      `allowBuilds grants ${dead.join(', ')}, which no longer resolve in pnpm-lock.yaml. ` +
        'A grant outliving its dependency grants nothing today and silently re-grants execution ' +
        "the moment the package returns as somebody's transitive.",
    );
  }

  if (RETIRED_KEY_RE.test(sources.workspace)) {
    violations.push(
      "pnpm-workspace.yaml declares the retired pnpm 10 key 'onlyBuiltDependencies'. pnpm 11 " +
        'ignores it silently, so the mistake denies every allowlisted script with no error.',
    );
  }

  if (BYPASS_KEY_RE.test(sources.workspace)) {
    violations.push(
      'pnpm-workspace.yaml sets `dangerouslyAllowAllBuilds: true`, which makes pnpm run every ' +
        'dependency lifecycle script and overrides even the explicit `false` denies. It defeats ' +
        `the allowlist and ${INVENTORY} entirely, in one line, with no entry to review.`,
    );
  }

  const npmrcSetting = [...sources.npmrc.matchAll(/^ignore-scripts[ \t]*=[ \t]*(\S+)/gm)].at(-1);
  if (npmrcSetting?.[1] !== 'true') {
    violations.push(
      `.npmrc no longer sets ignore-scripts=true (effective value: ${npmrcSetting?.[1] ?? 'unset'}). ` +
        "It suppresses the repo's OWN lifecycle scripts and is required by the published " +
        'requirement; dependency scripts are governed by pnpm-workspace.yaml::allowBuilds.',
    );
  }

  violations.push(...findImageInstallViolations(sources.dockerfile));

  return violations;
}

function findImageInstallViolations(dockerfile: string): string[] {
  const violations: string[] = [];
  const instructions = dockerfile.replace(/^[ \t]*#.*$/gm, '');
  const joined = instructions.replace(/\\\r?\n\s*/g, ' ');
  const stages = joined.split(/^[ \t]*FROM /m).slice(1);
  const stageName = (stage: string) =>
    /(?:^|\s)AS\s+(\S+)/i.exec(stage.split('\n')[0] ?? '')?.[1] ?? '<unnamed>';

  const installRe = /^[ \t]*RUN\b[^\n]*\bpnpm install\b/m;
  const installing = stages.filter((stage) => installRe.test(stage));
  if (installing.length === 0) {
    violations.push(
      'apps/web/Dockerfile: no stage runs `pnpm install`, so every image-build check below is ' +
        'vacuous. If the install moved, point this assertion at wherever it moved to.',
    );
  }

  for (const stage of installing) {
    const installAt = stage.search(installRe);
    for (const file of ['pnpm-workspace.yaml', '.npmrc'] as const) {
      const copyRe = new RegExp(`^[ \\t]*COPY\\b[^\\n]*${file.replace('.', '\\.')}`, 'm');
      const copyAt = stage.search(copyRe);
      if (copyAt === -1 || copyAt > installAt) {
        violations.push(
          `apps/web/Dockerfile stage '${stageName(stage)}' runs \`pnpm install\` without COPYing ` +
            `${file} into that stage first. ${
              file === 'pnpm-workspace.yaml'
                ? 'That file is what makes lifecycle scripts default-deny — without it in the ' +
                  'ancestor chain the stage installs under a policy nobody reviewed.'
                : 'It is required by the published requirement and is defence in depth.'
            }`,
        );
      }
    }
  }

  const expected = new Set<string>(ALLOWED_BUILD_SCRIPTS);
  for (const stage of stages) {
    if (/--dangerously-allow-all-builds|--config\.dangerouslyAllowAllBuilds/.test(stage)) {
      violations.push(
        `apps/web/Dockerfile stage '${stageName(stage)}' passes a dangerously-allow-all-builds ` +
          'flag, which makes pnpm run every lifecycle script and overrides even explicit `false` ' +
          'denies. No allowlist entry and no inventory edit would be needed.',
      );
    }
    for (const match of stage.matchAll(/\bpnpm rebuild\b([^\n&|;]*)/g)) {
      const named = match[1]!
        .trim()
        .split(/\s+/)
        .filter((a) => a.length > 0 && !a.startsWith('-'));
      if (named.length === 0) {
        violations.push(
          `apps/web/Dockerfile stage '${stageName(stage)}' runs \`pnpm rebuild\` with no package ` +
            'arguments, which makes the subset check below vacuous. Name the packages explicitly.',
        );
        continue;
      }
      const unpinned = named.filter((name) => !expected.has(name));
      if (unpinned.length > 0) {
        violations.push(
          `apps/web/Dockerfile stage '${stageName(stage)}' runs \`pnpm rebuild\` for ` +
            `${unpinned.join(', ')}, which ${INVENTORY} does not pin. pnpm honours \`allowBuilds\` ` +
            'here today, so this is a guard rather than a live hole — but a rebuild argument is the ' +
            'shape a grant would take if that ever changed.',
        );
      }
    }
  }

  return violations;
}

function resolvesInLockfile(lockfile: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^ {2}'?${escaped}@`, 'm').test(lockfile);
}
