#!/usr/bin/env node
/**
 * Mutation check: weaken a condition, confirm the tests that name it go red,
 * restore. Exists because doing this by hand loses the working tree — a
 * mid-loop failure leaves a mutated file behind, and a `cd` in the wrong
 * shell runs the suite against the wrong workspace.
 *
 * Restore is unconditional and byte-verified: the file is compared against
 * its backup before the process exits, on every path including a crash.
 *
 *   node scripts/mutate.mjs --file <path> --spec <vitest path> \
 *     --mutation '<find>' --with '<replace>' [--mutation … --with …] [-t <filter>]
 *
 * `--mutation` and `--with` are separate flags rather than one delimited
 * string because every plausible delimiter (`=>` above all) occurs in the
 * TypeScript being matched. Pass `--with ''` to delete the match.
 *
 * Each pair runs as its own case, applied to the pristine file. Exits
 * non-zero when a mutation reddens NOTHING — that is the finding: the
 * condition it removed is not covered by any test.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = { mutations: [], filter: null, file: null, spec: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') out.file = argv[(i += 1)];
    else if (a === '--spec') out.spec = argv[(i += 1)];
    else if (a === '--mutation') {
      if (argv[i + 2] !== '--with') {
        throw new Error(`--mutation must be followed by --with: ${argv[i + 1]}`);
      }
      out.mutations.push({ find: argv[i + 1], replace: argv[i + 3] });
      i += 3;
    } else if (a === '-t' || a === '--filter') out.filter = argv[(i += 1)];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.file || !out.spec || out.mutations.length === 0) {
    throw new Error('required: --file <path> --spec <path> --mutation <find> --with <replace>');
  }
  return out;
}

/** Vitest exits non-zero on failure, so a throw here means "something went red". */
function runSpec(spec, filter) {
  const args = ['vitest', 'run', spec, ...(filter ? ['-t', filter] : [])];
  try {
    return {
      red: false,
      out: execFileSync('pnpm', args, { cwd: resolve(REPO, 'apps/server'), encoding: 'utf8' }),
    };
  } catch (err) {
    return { red: true, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function failedTestNames(output) {
  return [...output.matchAll(/^\s+×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((m) => m[1].trim());
}

const args = parseArgs(process.argv.slice(2));
const target = resolve(REPO, args.file);
const backup = `${target}.mutate-backup`;
copyFileSync(target, backup);
const pristine = readFileSync(target, 'utf8');

let restored = false;
function restore() {
  if (restored) return;
  copyFileSync(backup, target);
  if (readFileSync(target, 'utf8') !== pristine) {
    // Louder than an exception: the tree is wrong and a human must look.
    process.stderr.write(
      `\nFATAL: ${target} did not restore byte-identically. Backup: ${backup}\n`,
    );
    process.exit(2);
  }
  execFileSync('rm', ['-f', backup]);
  restored = true;
}
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) process.on(sig, restore);

console.log(`baseline: ${args.spec}${args.filter ? ` -t "${args.filter}"` : ''}`);
const baseline = runSpec(args.spec, args.filter);
if (baseline.red) {
  console.error('baseline is already red — fix that before mutating.');
  console.error(
    failedTestNames(baseline.out)
      .map((n) => `  × ${n}`)
      .join('\n'),
  );
  process.exit(1);
}
console.log('  green\n');

let uncovered = 0;
for (const { find, replace } of args.mutations) {
  const occurrences = pristine.split(find).length - 1;
  if (occurrences !== 1) {
    console.error(`SKIP (matched ${occurrences}×, need exactly 1): ${find.slice(0, 60)}`);
    uncovered += 1;
    continue;
  }
  // A replacer FUNCTION, because a replacement STRING is scanned for `$'`,
  // `` $` ``, `$&` and `$n`. A shell snippet carrying `$'\x01'` therefore
  // spliced the rest of the file in, and the mutation "caught by 46 tests" was
  // really a syntax error.
  writeFileSync(
    target,
    pristine.replace(find, () => replace),
  );
  const { red, out } = runSpec(args.spec, args.filter);
  const names = failedTestNames(out);
  console.log(`mutation: ${find.slice(0, 70)}${find.length > 70 ? '…' : ''}`);
  if (red && names.length > 0) {
    console.log(`  CAUGHT by ${names.length}:`);
    for (const n of names) console.log(`    × ${n}`);
  } else {
    console.log('  NOT CAUGHT — no test covers this condition');
    uncovered += 1;
  }
  console.log();
  writeFileSync(target, pristine);
}

restore();
console.log(
  uncovered === 0
    ? `all ${args.mutations.length} mutations caught; ${basename(target)} restored`
    : `${uncovered} of ${args.mutations.length} NOT caught`,
);
process.exit(uncovered === 0 ? 0 : 1);
