#!/usr/bin/env node
// Migrations apply in file-name order and are recorded by file name, so a duplicate,
// a gap, or an edited/renumbered migration gives fresh and upgraded databases different histories.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = 'packages/db/src/migrations';
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const COUNT_GATES = [
  { file: '.github/workflows/ci.yml', pattern: /\[ "\$applied" = (\d+) \]/ },
  { file: 'apps/web/Dockerfile', pattern: /\[ "\$migrations" -eq (\d+) \]/ },
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = resolve(arg('--root') ?? '.');
const base = arg('--base');
const dir = join(root, MIGRATIONS);
const errors = [];

function git(...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const byNumber = new Map();
for (const file of files) {
  const match = NAME.exec(file);
  if (!match) {
    errors.push(`${file}: name must match NNNN_snake_case.sql`);
    continue;
  }
  byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), file]);
}

for (const [number, names] of byNumber) {
  if (names.length > 1) errors.push(`${number} is used by ${names.join(' and ')}`);
}

const numbers = [...byNumber.keys()].sort();
const gap = numbers.findIndex((number, index) => number !== String(index).padStart(4, '0'));
if (gap !== -1) {
  errors.push(`${byNumber.get(numbers[gap])[0]}: expected number ${String(gap).padStart(4, '0')}`);
}

for (const gate of COUNT_GATES) {
  const path = join(root, gate.file);
  const found = existsSync(path) ? gate.pattern.exec(readFileSync(path, 'utf8')) : null;
  if (!found) {
    errors.push(`${gate.file}: migration count gate not found`);
  } else if (Number(found[1]) !== files.length) {
    errors.push(`${gate.file} expects ${found[1]} migrations, found ${files.length}`);
  }
}

if (base && !/^0+$/.test(base)) {
  if (git('rev-parse', '--verify', '--quiet', `${base}^{commit}`).status !== 0) {
    errors.push(`cannot resolve base ${base}`);
  } else {
    const listed = git('ls-tree', '-r', base, '--', MIGRATIONS).stdout.trim();
    for (const line of listed ? listed.split('\n') : []) {
      const [meta, path] = line.split('\t');
      const name = path.slice(MIGRATIONS.length + 1);
      if (!name.endsWith('.sql') || name.includes('/')) continue;
      const blob = meta.split(' ')[2];
      if (!files.includes(name)) {
        errors.push(`${name} exists on the base and was renamed or removed`);
      } else if (git('hash-object', join(MIGRATIONS, name)).stdout.trim() !== blob) {
        errors.push(`${name} exists on the base and was edited`);
      }
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`check-migrations: ${e}`);
  console.error(
    'check-migrations: number a new migration after the last one on main, never edit or renumber one already on main, and update the count gates.',
  );
  process.exit(1);
}
console.log(`check-migrations: ok (${files.length} migrations)`);
