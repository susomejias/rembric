import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one tracked enumeration of which dependencies may execute code at install
 * time, outside `pnpm-workspace.yaml::allowBuilds` itself.
 *
 * Same disease and same cure as `schema-inventory.ts`. This fact had six
 * hand-maintained prose copies and every one understated the `true` count,
 * because nothing compared the prose to the file.
 *
 * Justification text is deliberately NOT duplicated here: the reason an entry
 * exists lives in the YAML comment beside the entry, and the assertions check
 * that a comment EXISTS without ever comparing its wording.
 */
export const ALLOWED_BUILD_SCRIPTS = [
  'better-sqlite3',
  'husky',
  'onnxruntime-node',
  'sqlite-vec',
] as const;

interface AllowBuildsEntry {
  name: string;
  allowed: boolean;
  /** The trailing `#` comment, empty when the entry carries none. */
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
// pnpm's createAllowBuildFunction returns `() => true` on this before it reads
// allowBuilds at all, so it grants every package and overrides explicit denies.
const BYPASS_KEY_RE = /^[ \t]*dangerouslyAllowAllBuilds[ \t]*:[ \t]*true\b/m;
// The name charset is the legal npm-name one rather than "anything but space,
// colon or hash": the looser form admits `'husky': true`, whose quotes make it a
// different key to pnpm while parsing here as a plain entry.
const ENTRY_RE = /^ {2}([@A-Za-z0-9._/-]+):[ \t]*(true|false)[ \t]*(?:#[ \t]*(\S.*?))?[ \t]*$/;

/** Every file the install-time policy is spread across, so a new input is one edit. */
export function readSupplyChainSources(repoRoot: string): SupplyChainSources {
  return {
    workspace: readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
    lockfile: readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    npmrc: readFileSync(join(repoRoot, '.npmrc'), 'utf8'),
    dockerfile: readFileSync(join(repoRoot, 'apps/server/Dockerfile'), 'utf8'),
  };
}

/**
 * Scoped line scanner over the `allowBuilds:` block. No YAML dependency: adding
 * one to fix a supply-chain documentation bug would enlarge the surface under
 * audit (design.md Context).
 *
 * Fails closed — an in-block line the scanner cannot classify throws with the
 * line quoted, never a skip, because a line the scanner shrugs at is how a
 * code-execution grant hides (design D5).
 */
export function parseAllowBuilds(source: string): AllowBuildsEntry[] {
  // CRLF normalised first: without it a checkout with core.autocrlf reds every
  // assertion with a message about a key rename that never happened.
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
    // Blank and comment lines before the unindented break: '' fails /^[ \t]/.
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

// Named by export, not by path: the requirement deliberately does not pin where
// this module lives, so a message quoting its path would rot on any move.
const INVENTORY = 'ALLOWED_BUILD_SCRIPTS';

/**
 * Every violation of the install-time code-execution policy observable from the
 * working tree, as messages naming the offender.
 *
 * A working-tree property rather than a diff-scoped CI script (design D4): it
 * fails on every run — local `pnpm test`, pre-push and CI, including on the
 * branch that added the entry — and needs no base ref to resolve.
 */
export function findSupplyChainViolations(sources: SupplyChainSources): string[] {
  const violations: string[] = [];
  const entries = parseAllowBuilds(sources.workspace);
  const granted = entries.filter((e) => e.allowed).map((e) => e.name);

  // Non-vacuity before any set comparison: a match against an empty parse is
  // satisfiable by construction and would prove nothing.
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

  // Keyed, not substring: the file legitimately names the retired key in a
  // comment explaining why it was replaced. Reached only when BOTH keys are
  // present, which pnpm 11 tolerates in silence.
  if (RETIRED_KEY_RE.test(sources.workspace)) {
    violations.push(
      "pnpm-workspace.yaml declares the retired pnpm 10 key 'onlyBuiltDependencies'. pnpm 11 " +
        'ignores it silently, so the mistake denies every allowlisted script with no error.',
    );
  }

  // The one true bypass, and the reason this check exists at all: pnpm honours it
  // before reading allowBuilds, so it grants every package AND overrides explicit
  // `false` denies. A top-level key is invisible to the block parser above, which
  // stops at the first unindented line.
  if (BYPASS_KEY_RE.test(sources.workspace)) {
    violations.push(
      'pnpm-workspace.yaml sets `dangerouslyAllowAllBuilds: true`, which makes pnpm run every ' +
        'dependency lifecycle script and overrides even the explicit `false` denies. It defeats ' +
        `the allowlist and ${INVENTORY} entirely, in one line, with no entry to review.`,
    );
  }

  // ini is last-wins, so the LAST assignment is the effective one. Measured against
  // pnpm 11.1.2: this knob does NOT gate dependency lifecycle scripts (allowBuilds
  // does), so it is asserted because the published requirement mandates the file's
  // shape, not because the allowlist depends on it.
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

/**
 * Whether a Dockerfile stage can execute a dependency's lifecycle script.
 *
 * Measured against the pinned pnpm 11.1.2, with `esbuild@0.25.10` as the oracle
 * (its `bin/esbuild` is a JS shim in the tarball and an ELF binary only after its
 * postinstall runs), because the intuitive account of this is wrong in both
 * directions:
 *
 * - `.npmrc::ignore-scripts=true` does NOT gate dependency lifecycle scripts.
 *   With it set and `allowBuilds: {esbuild: true}`, the script RAN. With no
 *   `.npmrc` at all and no `allowBuilds`, pnpm refused
 *   (`ERR_PNPM_IGNORED_BUILDS`). Default-deny comes from `allowBuilds`, so
 *   `pnpm-workspace.yaml` is the file that must reach an installing stage.
 * - `pnpm rebuild <pkg>` DOES respect `allowBuilds`: with esbuild ungranted,
 *   `pnpm rebuild esbuild` left the shim untouched. Its argument list is checked
 *   anyway, as the cheapest guard against a future pnpm that changes this and
 *   against a bypass flag on the same line — it can only false-alarm.
 *
 * The one true bypass is `dangerouslyAllowAllBuilds`, which pnpm's own
 * `createAllowBuildFunction` honours before it reads `allowBuilds` at all
 * (`if (opts.dangerouslyAllowAllBuilds) return () => true`), so it overrides even
 * explicit `false` denies. Checked as a config key and as a CLI flag.
 */
function findImageInstallViolations(dockerfile: string): string[] {
  const violations: string[] = [];
  // Join `\`-continued instructions first: a COPY or rebuild split across lines
  // is one instruction to BuildKit and must not read as a missing one here.
  const joined = dockerfile.replace(/\\\r?\n\s*/g, ' ');
  const stages = joined.split(/^[ \t]*FROM /m).slice(1);
  const stageName = (stage: string) =>
    /(?:^|\s)AS\s+(\S+)/i.exec(stage.split('\n')[0] ?? '')?.[1] ?? '<unnamed>';

  const installRe = /^[ \t]*RUN\b[^\n]*\bpnpm install\b/m;
  const installing = stages.filter((stage) => installRe.test(stage));
  if (installing.length === 0) {
    violations.push(
      'apps/server/Dockerfile: no stage runs `pnpm install`, so every image-build check below is ' +
        'vacuous. If the install moved, point this assertion at wherever it moved to.',
    );
  }

  for (const stage of installing) {
    const installAt = stage.search(installRe);
    // Ordinal, not merely present: a COPY after the install cannot have governed it.
    for (const file of ['pnpm-workspace.yaml', '.npmrc'] as const) {
      const copyRe = new RegExp(`^[ \\t]*COPY\\b[^\\n]*${file.replace('.', '\\.')}`, 'm');
      const copyAt = stage.search(copyRe);
      if (copyAt === -1 || copyAt > installAt) {
        violations.push(
          `apps/server/Dockerfile stage '${stageName(stage)}' runs \`pnpm install\` without COPYing ` +
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
        `apps/server/Dockerfile stage '${stageName(stage)}' passes a dangerously-allow-all-builds ` +
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
          `apps/server/Dockerfile stage '${stageName(stage)}' runs \`pnpm rebuild\` with no package ` +
            'arguments, which makes the subset check below vacuous. Name the packages explicitly.',
        );
        continue;
      }
      const unpinned = named.filter((name) => !expected.has(name));
      if (unpinned.length > 0) {
        violations.push(
          `apps/server/Dockerfile stage '${stageName(stage)}' runs \`pnpm rebuild\` for ` +
            `${unpinned.join(', ')}, which ${INVENTORY} does not pin. pnpm honours \`allowBuilds\` ` +
            'here today, so this is a guard rather than a live hole — but a rebuild argument is the ' +
            'shape a grant would take if that ever changed.',
        );
      }
    }
  }

  return violations;
}

/**
 * Anchored on the lockfile's `<name>@<version>` key shape at two-space
 * indentation, so `sqlite-vec` cannot be satisfied by `sqlite-vec-anything`.
 * The optional quote is load-bearing: lockfile v9 quotes every key starting with
 * `@`, so an unquoted pattern can never resolve a scoped package.
 */
function resolvesInLockfile(lockfile: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^ {2}'?${escaped}@`, 'm').test(lockfile);
}
